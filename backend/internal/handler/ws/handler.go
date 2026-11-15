// Package ws serves the realtime WebSocket endpoint GET /api/v1/projects/{id}/ws
// (docs/04-api.md, section 7).
package ws

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

// Protocol limits (docs/02-architecture.md, section 6).
const (
	// MaxFrameBytes is the largest accepted client frame.
	MaxFrameBytes = 4 << 10

	DefaultAuthTimeout   = 5 * time.Second
	DefaultReauthTimeout = 5 * time.Second
	DefaultIdleTimeout   = 45 * time.Second
	DefaultWriteTimeout  = 10 * time.Second

	// DefaultMaxConnsPerUser bounds the simultaneous connections of one user across all rooms:
	// enough for several tabs and devices, small enough that one stolen or buggy account cannot
	// exhaust sockets and goroutines of a 2 GB server.
	DefaultMaxConnsPerUser = 8

	// ctrlQueue bounds the replies the reader may queue for the writer.
	ctrlQueue = 16
)

// Config configures the handler.
type Config struct {
	Collab *service.Collab
	// AllowedOrigins are extra origins (scheme://host) accepted besides the
	// request's own host.
	AllowedOrigins []string

	AuthTimeout   time.Duration
	ReauthTimeout time.Duration
	IdleTimeout   time.Duration
	WriteTimeout  time.Duration
	// MaxConnsPerUser caps the sockets of one user (live plus the ones still being closed).
	// A connection arriving at the cap is rejected with 1008 TOO_MANY_CONNECTIONS and, so a
	// dead tab or a dropped network cannot lock the user out, the oldest live connection is
	// evicted (one at a time); the client's retry succeeds once that socket is gone, within
	// about closeTimeout. Rejecting instead of admitting and then evicting is what keeps the
	// number of sockets from ever exceeding the cap. Clients should retry with backoff.
	// Zero selects DefaultMaxConnsPerUser.
	MaxConnsPerUser int
	// Now overrides time.Now for token expiry checks in tests.
	Now func() time.Time
}

// Handler upgrades requests to WebSocket connections and runs the protocol.
type Handler struct {
	cfg      Config
	patterns []string
	mu       sync.Mutex // guards closing together with wg.Add, so Add never runs concurrently with Wait
	closing  bool
	wg       sync.WaitGroup

	connMu sync.Mutex
	conns  map[string]*userConns
}

// userConns tracks the sockets of one user. Evicted connections stay in closing until their
// ServeProject really returns, so they keep counting against the cap while they linger.
type userConns struct {
	live    []*connection // oldest first
	closing []*connection
}

// register admits c for userID or reports false when the user is at the cap (see
// Config.MaxConnsPerUser). The eviction is started after connMu is released: no network call
// ever runs under the lock.
func (h *Handler) register(userID string, c *connection) bool {
	h.connMu.Lock()
	u := h.conns[userID]
	if u == nil {
		u = &userConns{}
		h.conns[userID] = u
	}
	if len(u.live)+len(u.closing) >= h.cfg.MaxConnsPerUser {
		var victim *connection
		if len(u.closing) == 0 && len(u.live) > 0 {
			victim, u.live = u.live[0], u.live[1:]
			u.closing = append(u.closing, victim)
		}
		h.connMu.Unlock()
		if victim != nil {
			go victim.closeWith(websocket.StatusPolicyViolation, "TOO_MANY_CONNECTIONS")
		}
		return false
	}
	c.userID = userID
	u.live = append(u.live, c)
	h.connMu.Unlock()
	return true
}

// unregister forgets c when its handler returns; it is a no-op for a connection that was never admitted.
func (h *Handler) unregister(c *connection) {
	if c.userID == "" {
		return
	}
	h.connMu.Lock()
	defer h.connMu.Unlock()
	u := h.conns[c.userID]
	if u == nil {
		return
	}
	u.live = removeConn(u.live, c)
	u.closing = removeConn(u.closing, c)
	if len(u.live)+len(u.closing) == 0 {
		delete(h.conns, c.userID)
	}
}

func removeConn(list []*connection, c *connection) []*connection {
	for i, x := range list {
		if x == c {
			return append(list[:i:i], list[i+1:]...)
		}
	}
	return list
}

// userConnCount returns how many sockets of the user are registered (live plus closing).
func (h *Handler) userConnCount(userID string) int {
	h.connMu.Lock()
	defer h.connMu.Unlock()
	if u := h.conns[userID]; u != nil {
		return len(u.live) + len(u.closing)
	}
	return 0
}

// enter registers one live connection. It refuses once Shutdown has started.
func (h *Handler) enter() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return false
	}
	h.wg.Add(1)
	return true
}

// New builds a Handler, filling in default timeouts.
func New(cfg Config) *Handler {
	if cfg.AuthTimeout <= 0 {
		cfg.AuthTimeout = DefaultAuthTimeout
	}
	if cfg.ReauthTimeout <= 0 {
		cfg.ReauthTimeout = DefaultReauthTimeout
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = DefaultIdleTimeout
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = DefaultWriteTimeout
	}
	if cfg.MaxConnsPerUser <= 0 {
		cfg.MaxConnsPerUser = DefaultMaxConnsPerUser
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	h := &Handler{cfg: cfg, conns: make(map[string]*userConns)}
	for _, o := range cfg.AllowedOrigins {
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			h.patterns = append(h.patterns, u.Host)
		} else if o != "" {
			h.patterns = append(h.patterns, o)
		}
	}
	return h
}

// ServeHTTP serves the route; the project id is read from the chi URL
// parameter "id".
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.ServeProject(w, r, chi.URLParam(r, "id"))
}

// Shutdown refuses new connections, closes the live ones with 1001 and waits
// for their goroutines to finish or for ctx to end.
func (h *Handler) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closing = true
	h.mu.Unlock()
	err := h.cfg.Collab.Shutdown(ctx)
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// outMsg is a frame queued for the writer; a non-zero closeCode closes the
// connection right after the frame is written.
type outMsg struct {
	data        []byte
	closeCode   websocket.StatusCode
	closeReason string
}

// connection owns one WebSocket. Only the writer goroutine calls Write, so
// frames never interleave; closing is safe from any goroutine.
type connection struct {
	h    *Handler
	conn *websocket.Conn
	raw  net.Conn // the hijacked socket, kept to force-close a peer that stalls the close handshake
	ctx  context.Context
	// projectID is the room this connection belongs to, needed to re-check access.
	projectID string
	userID    string // set once the connection is admitted by Handler.register
	ctrl      chan outMsg
	log       zerolog.Logger
	// writerDone is closed when the writer goroutine has exited.
	writerDone chan struct{}

	closeOnce sync.Once

	mu          sync.Mutex
	idle        *time.Timer
	reauthTimer *time.Timer
	expTimer    *time.Timer
}

// hijackRecorder remembers the socket the websocket library hijacks. The library offers no way to
// abort a close frame that is stuck in a blocked write (CloseNow waits for it), so the only hard
// stop is closing the raw socket underneath.
type hijackRecorder struct {
	http.ResponseWriter
	conn net.Conn
}

func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := h.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	c, rw, err := hj.Hijack()
	h.conn = c
	return c, rw, err
}

// closeTimeout bounds the close handshake: a peer that never reads must not hold the socket
// (or the goroutine that closes it) for the library's default of several seconds.
const closeTimeout = time.Second

// closeWith sends the close frame and waits at most closeTimeout for the peer's answer, then
// drops the socket. It may block for that long, so never call it under a lock.
func (c *connection) closeWith(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = c.conn.Close(code, reason)
		}()
		select {
		case <-done:
		case <-time.After(closeTimeout):
			if c.raw != nil {
				_ = c.raw.Close()
			}
			_ = c.conn.CloseNow()
			<-done
		}
	})
}

func (c *connection) write(data []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// enqueue hands a frame to the writer, giving up when the connection ends.
func (c *connection) enqueue(m outMsg) {
	select {
	case c.ctrl <- m:
	case <-c.ctx.Done():
	}
}

// ServeProject runs one connection for projectID.
func (h *Handler) ServeProject(w http.ResponseWriter, r *http.Request, projectID string) {
	if !h.enter() {
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	defer h.wg.Done()
	log := logging.FromContext(r.Context())
	hj := &hijackRecorder{ResponseWriter: w}
	conn, err := websocket.Accept(hj, r, &websocket.AcceptOptions{
		OriginPatterns:  h.patterns,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		log.Debug().Err(err).Msg("websocket upgrade rejected")
		return
	}
	conn.SetReadLimit(MaxFrameBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &connection{h: h, conn: conn, raw: hj.conn, ctx: ctx, projectID: projectID, ctrl: make(chan outMsg, ctrlQueue), log: log, writerDone: make(chan struct{})}
	defer conn.CloseNow() //nolint:errcheck // best-effort cleanup after the protocol close
	defer h.unregister(c)

	actor, sess, ok := h.handshake(c, projectID)
	if !ok {
		return
	}
	defer sess.Leave()
	defer c.stopTimers()

	go func() {
		defer close(c.writerDone)
		// Cancel first (defers run last-in first): when the writer dies on a write timeout the
		// reader may be blocked in enqueue on a full queue, and only the cancelled context frees it.
		defer cancel()
		c.writeLoop(sess)
	}()
	c.readLoop(sess, actor)
	cancel()
	<-c.writerDone
}

// handshake performs the auth frame exchange, joins the room and sends hello.
func (h *Handler) handshake(c *connection, projectID string) (domain.Actor, domain.RoomSession, bool) {
	authTimer := time.AfterFunc(h.cfg.AuthTimeout, func() { c.closeWith(websocket.StatusPolicyViolation, "AUTH_TIMEOUT") })
	typ, data, err := c.conn.Read(c.ctx)
	authTimer.Stop()
	if err != nil {
		return domain.Actor{}, nil, false
	}
	var f inbound
	if typ != websocket.MessageText || json.Unmarshal(data, &f) != nil || f.T != frameAuth || f.Token == "" {
		c.reject(domain.ErrUnauthenticated)
		return domain.Actor{}, nil, false
	}
	actor, err := h.cfg.Collab.Authenticate(c.ctx, f.Token)
	if err != nil {
		c.reject(err)
		return domain.Actor{}, nil, false
	}
	if !actor.TokenExp.IsZero() && !h.cfg.Now().Before(actor.TokenExp) {
		c.reject(domain.ErrTokenExpired)
		return domain.Actor{}, nil, false
	}
	if !h.register(actor.UserID, c) {
		c.closeWith(websocket.StatusPolicyViolation, "TOO_MANY_CONNECTIONS")
		return domain.Actor{}, nil, false
	}
	sess, err := h.cfg.Collab.Join(c.ctx, actor, projectID)
	if err != nil {
		c.reject(err)
		return domain.Actor{}, nil, false
	}
	hello, err := encodeHello(sess.Snapshot())
	if err == nil {
		err = c.write(hello)
	}
	if err != nil {
		sess.Leave()
		return domain.Actor{}, nil, false
	}
	c.armIdle()
	c.armExpiry(actor)
	return actor, sess, true
}

// reject reports err to the client and closes the connection. Auth and
// permission problems close with 1008, infrastructure failures with 1011/1013.
func (c *connection) reject(err error) {
	code, status, msg := classify(err)
	if status == websocket.StatusInternalError {
		c.log.Error().Err(err).Msg("websocket handshake failed")
	}
	_ = c.write(encodeError(string(code), msg))
	c.closeWith(status, string(code))
}

// classify maps an error to its API code, close status and client message.
func classify(err error) (domain.Code, websocket.StatusCode, string) {
	code := domain.CodeOf(err)
	switch code {
	case domain.CodeInternal, "":
		return domain.CodeInternal, websocket.StatusInternalError, "internal server error"
	case domain.CodeAuthUnavailable:
		return code, websocket.StatusTryAgainLater, err.Error()
	default:
		return code, websocket.StatusPolicyViolation, err.Error()
	}
}

func (c *connection) armIdle() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.idle = time.AfterFunc(c.h.cfg.IdleTimeout, func() { c.closeWith(websocket.StatusPolicyViolation, "IDLE_TIMEOUT") })
}

func (c *connection) touchIdle() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.idle != nil {
		c.idle.Reset(c.h.cfg.IdleTimeout)
	}
}

// armExpiry closes the connection when the token expires without renewal.
func (c *connection) armExpiry(a domain.Actor) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.expTimer != nil {
		c.expTimer.Stop()
		c.expTimer = nil
	}
	if a.TokenExp.IsZero() {
		return
	}
	d := a.TokenExp.Sub(c.h.cfg.Now())
	c.expTimer = time.AfterFunc(max(d, 0), func() { c.closeWith(websocket.StatusPolicyViolation, string(domain.CodeTokenExpired)) })
}

// startReauth begins the grace period in which the client must send a new auth frame.
func (c *connection) startReauth() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reauthTimer != nil {
		return
	}
	c.reauthTimer = time.AfterFunc(c.h.cfg.ReauthTimeout, func() { c.closeWith(websocket.StatusPolicyViolation, "REAUTH_TIMEOUT") })
}

func (c *connection) endReauth() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reauthTimer != nil {
		c.reauthTimer.Stop()
		c.reauthTimer = nil
	}
}

func (c *connection) stopTimers() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, t := range []*time.Timer{c.idle, c.reauthTimer, c.expTimer} {
		if t != nil {
			t.Stop()
		}
	}
}

// writeLoop is the only goroutine that writes to the socket.
func (c *connection) writeLoop(sess domain.RoomSession) {
	for {
		select {
		case ev := <-sess.Events():
			data, ok, err := encodeEvent(ev)
			if err != nil {
				c.closeWith(websocket.StatusInternalError, string(domain.CodeInternal))
				return
			}
			if !ok {
				continue
			}
			if ev.EventType() == domain.EventReauth {
				c.startReauth()
			}
			if c.write(data) != nil {
				return
			}
		case m := <-c.ctrl:
			if c.write(m.data) != nil {
				return
			}
			if m.closeCode != 0 {
				c.closeWith(m.closeCode, m.closeReason)
				return
			}
		case <-sess.Closed():
			code, reason := closeStatus(sess.CloseReason())
			c.closeWith(code, reason)
			return
		case <-c.ctx.Done():
			return
		}
	}
}

func closeStatus(r domain.CloseReason) (websocket.StatusCode, string) {
	switch r {
	case domain.CloseSlow:
		return websocket.StatusTryAgainLater, "SLOW_CLIENT"
	case domain.CloseKicked:
		return websocket.StatusPolicyViolation, string(domain.CodeForbidden)
	case domain.CloseShutdown:
		return websocket.StatusGoingAway, "SERVER_RESTART"
	default:
		return websocket.StatusNormalClosure, ""
	}
}

// readLoop parses client frames until the connection ends.
func (c *connection) readLoop(sess domain.RoomSession, actor domain.Actor) {
	for {
		typ, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		c.touchIdle()
		if !sess.Allow() {
			c.enqueue(outMsg{
				data:      encodeError(string(domain.CodeRateLimited), "too many messages"),
				closeCode: websocket.StatusPolicyViolation, closeReason: string(domain.CodeRateLimited),
			})
			<-c.writerDone // let the writer deliver the error frame and the close
			return
		}
		var f inbound
		if typ != websocket.MessageText || json.Unmarshal(data, &f) != nil {
			c.enqueue(outMsg{data: encodeError(string(domain.CodeValidation), "malformed frame")})
			continue
		}
		next, ok := c.handleFrame(sess, actor, f)
		if !ok {
			<-c.writerDone
			return
		}
		actor = next
	}
}

// handleFrame processes one client frame. It returns the (possibly renewed)
// actor and false when the connection must end.
func (c *connection) handleFrame(sess domain.RoomSession, actor domain.Actor, f inbound) (domain.Actor, bool) {
	svc := c.h.cfg.Collab
	switch f.T {
	case frameAuth:
		return c.reauthenticate(actor, f.Token)
	case framePing:
		svc.Heartbeat(sess)
		c.enqueue(outMsg{data: pongFrame})
	case frameCursor:
		cur := domain.Cursor{}
		if f.RowID != nil && *f.RowID != "" {
			if !validID(*f.RowID, maxRowIDLen) || len(f.Field) > maxCursorFieldSz {
				c.enqueue(outMsg{data: encodeError(string(domain.CodeValidation), "invalid cursor")})
				return actor, true
			}
			cur = domain.Cursor{RowID: *f.RowID, Field: f.Field}
		}
		if err := svc.SetCursor(actor, sess, cur); err != nil {
			c.replyError(err)
		}
	case frameLockAcquire:
		if f.RowID == nil || !validID(*f.RowID, maxRowIDLen) {
			c.enqueue(outMsg{data: encodeError(string(domain.CodeValidation), "rowId is required")})
			return actor, true
		}
		if _, err := svc.Acquire(c.ctx, actor, sess, c.projectID, *f.RowID); err != nil {
			c.replyLockError(*f.RowID, err)
		}
	case frameLockRelease:
		if f.RowID == nil || !validID(*f.RowID, maxRowIDLen) {
			c.enqueue(outMsg{data: encodeError(string(domain.CodeValidation), "rowId is required")})
			return actor, true
		}
		svc.Release(sess, *f.RowID)
	default:
		c.enqueue(outMsg{data: encodeError(string(domain.CodeValidation), "unknown frame type")})
	}
	return actor, true
}

// reauthenticate handles an auth frame on a live connection (after a token
// refresh or in answer to reauth). The new token must belong to the same user
// and still carry the rights the connection needs, including visibility of the project
// (the join rules), so a revoked project.view_finished ends the connection.
func (c *connection) reauthenticate(cur domain.Actor, token string) (domain.Actor, bool) {
	svc := c.h.cfg.Collab
	fresh, err := svc.Authenticate(c.ctx, token)
	if err == nil && fresh.UserID != cur.UserID {
		err = domain.ErrForbidden
	}
	if err == nil {
		err = svc.Revalidate(c.ctx, fresh, c.projectID)
	}
	if err == nil && !fresh.TokenExp.IsZero() && !c.h.cfg.Now().Before(fresh.TokenExp) {
		err = domain.ErrTokenExpired
	}
	if err != nil {
		code, status, msg := classify(err)
		c.enqueue(outMsg{data: encodeError(string(code), msg), closeCode: status, closeReason: string(code)})
		return cur, false
	}
	c.endReauth()
	c.armExpiry(fresh)
	return fresh, true
}

func (c *connection) replyError(err error) {
	code, status, msg := classify(err)
	if status == websocket.StatusInternalError {
		c.log.Error().Err(err).Msg("websocket frame failed")
	}
	c.enqueue(outMsg{data: encodeError(string(code), msg)})
}

func (c *connection) replyLockError(rowID string, err error) {
	if errors.Is(err, domain.ErrRowLocked) {
		var de *domain.Error
		by := ""
		if errors.As(err, &de) {
			by, _ = de.Details["by"].(string)
		}
		if data, mErr := encodeDenied(rowID, by); mErr == nil {
			c.enqueue(outMsg{data: data})
		}
		return
	}
	c.replyError(err)
}
