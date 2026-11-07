package memory

import "github.com/prometheus/client_golang/prometheus"

// Metrics receives realtime instrumentation. The lead backs it with the
// platform metrics registry (see NewPromMetrics).
type Metrics interface {
	ConnectionOpened()
	ConnectionClosed()
	RoomOpened()
	RoomClosed()
	// MessageIn counts a client frame by type (ping, cursor, lock.acquire, lock.release).
	MessageIn(typ string)
	// MessageOut counts a server frame enqueued for a client, by type.
	MessageOut(typ string)
	SlowClientDisconnect()
	LockConflict()
}

// NopMetrics discards everything.
type NopMetrics struct{}

// ConnectionOpened implements Metrics.
func (NopMetrics) ConnectionOpened() {}

// ConnectionClosed implements Metrics.
func (NopMetrics) ConnectionClosed() {}

// RoomOpened implements Metrics.
func (NopMetrics) RoomOpened() {}

// RoomClosed implements Metrics.
func (NopMetrics) RoomClosed() {}

// MessageIn implements Metrics.
func (NopMetrics) MessageIn(string) {}

// MessageOut implements Metrics.
func (NopMetrics) MessageOut(string) {}

// SlowClientDisconnect implements Metrics.
func (NopMetrics) SlowClientDisconnect() {}

// LockConflict implements Metrics.
func (NopMetrics) LockConflict() {}

// PromMetrics is the Prometheus implementation of Metrics. Message types are a
// small fixed set, so label cardinality stays bounded.
type PromMetrics struct {
	connections prometheus.Gauge
	rooms       prometheus.Gauge
	in          *prometheus.CounterVec
	out         *prometheus.CounterVec
	slow        prometheus.Counter
	conflicts   prometheus.Counter
}

// NewPromMetrics creates the instruments and registers them on reg.
func NewPromMetrics(reg prometheus.Registerer) *PromMetrics {
	m := &PromMetrics{
		connections: prometheus.NewGauge(prometheus.GaugeOpts{Name: "tip_ws_connections", Help: "Open WebSocket connections."}),
		rooms:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "tip_ws_rooms", Help: "Project rooms with at least one client."}),
		in: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_ws_messages_in_total", Help: "Client frames accepted by the hub, by type.",
		}, []string{"type"}),
		out: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "tip_ws_messages_out_total", Help: "Server frames queued for clients, by type.",
		}, []string{"type"}),
		slow:      prometheus.NewCounter(prometheus.CounterOpts{Name: "tip_ws_slow_client_disconnects_total", Help: "Clients dropped because their send buffer overflowed."}),
		conflicts: prometheus.NewCounter(prometheus.CounterOpts{Name: "tip_ws_lock_conflicts_total", Help: "Row lock requests denied because another user holds the row."}),
	}
	reg.MustRegister(m.connections, m.rooms, m.in, m.out, m.slow, m.conflicts)
	return m
}

// ConnectionOpened implements Metrics.
func (m *PromMetrics) ConnectionOpened() { m.connections.Inc() }

// ConnectionClosed implements Metrics.
func (m *PromMetrics) ConnectionClosed() { m.connections.Dec() }

// RoomOpened implements Metrics.
func (m *PromMetrics) RoomOpened() { m.rooms.Inc() }

// RoomClosed implements Metrics.
func (m *PromMetrics) RoomClosed() { m.rooms.Dec() }

// MessageIn implements Metrics.
func (m *PromMetrics) MessageIn(typ string) { m.in.WithLabelValues(typ).Inc() }

// MessageOut implements Metrics.
func (m *PromMetrics) MessageOut(typ string) { m.out.WithLabelValues(typ).Inc() }

// SlowClientDisconnect implements Metrics.
func (m *PromMetrics) SlowClientDisconnect() { m.slow.Inc() }

// LockConflict implements Metrics.
func (m *PromMetrics) LockConflict() { m.conflicts.Inc() }
