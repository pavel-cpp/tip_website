package ws

import (
	"encoding/json"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Frame type names (docs/04-api.md, section 7).
const (
	frameAuth        = "auth"
	framePing        = "ping"
	frameCursor      = "cursor"
	frameLockAcquire = "lock.acquire"
	frameLockRelease = "lock.release"

	framePong        = "pong"
	frameHello       = "hello"
	frameReauth      = "reauth"
	framePresence    = "presence"
	frameLock        = "lock"
	frameUnlock      = "unlock"
	frameLockDenied  = "lock.denied"
	frameRowsUpsert  = "rows.upsert"
	frameRowsDelete  = "rows.delete"
	frameProjectUpd  = "project.updated"
	frameError       = "error"
	maxRowIDLen      = 64
	maxCursorFieldSz = 32
)

// inbound is the union of all client frames; unused fields stay zero.
type inbound struct {
	T     string  `json:"t"`
	Token string  `json:"token"`
	RowID *string `json:"rowId"`
	Field string  `json:"field"`
}

type peerDTO struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"displayName"`
	Color       string  `json:"color"`
	AvatarURL   *string `json:"avatarUrl"`
}

type cursorDTO struct {
	RowID *string `json:"rowId"`
	Field string  `json:"field,omitempty"`
}

type lockDTO struct {
	By        string    `json:"by"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type helloFrame struct {
	T          string               `json:"t"`
	You        string               `json:"you"`
	Peers      []peerDTO            `json:"peers"`
	Cursors    map[string]cursorDTO `json:"cursors"`
	Locks      map[string]lockDTO   `json:"locks"`
	ServerTime time.Time            `json:"serverTime"`
}

type presenceFrame struct {
	T     string    `json:"t"`
	Peers []peerDTO `json:"peers"`
}

type cursorFrame struct {
	T      string  `json:"t"`
	UserID string  `json:"userId"`
	RowID  *string `json:"rowId"`
	Field  string  `json:"field,omitempty"`
}

type lockFrame struct {
	T         string    `json:"t"`
	RowID     string    `json:"rowId"`
	By        string    `json:"by"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type deniedFrame struct {
	T     string `json:"t"`
	RowID string `json:"rowId"`
	By    string `json:"by"`
}

type rowsUpsertFrame struct {
	T     string           `json:"t"`
	Items []participantDTO `json:"items"`
}

type rowsDeleteFrame struct {
	T   string   `json:"t"`
	IDs []string `json:"ids"`
}

type projectFrame struct {
	T       string     `json:"t"`
	Project projectDTO `json:"project"`
}

type reauthFrame struct {
	T string `json:"t"`
}

type errorFrame struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type participantDTO struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Number    int       `json:"number"`
	Name      string    `json:"name"`
	Phone     string    `json:"phone"`
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type placeholderDTO struct {
	Font        string `json:"font"`
	Size        int    `json:"size"`
	Stroke      int    `json:"stroke"`
	Color       string `json:"color"`
	StrokeColor string `json:"strokeColor"`
	Bold        bool   `json:"bold"`
	Italic      bool   `json:"italic"`
	Underline   bool   `json:"underline"`
	X           int    `json:"x"`
	Y           int    `json:"y"`
}

type imageDTO struct {
	URL   string `json:"url"`
	Name  string `json:"name"`
	W     int    `json:"w"`
	H     int    `json:"h"`
	Bytes int    `json:"bytes"`
}

// projectDTO is the project part a realtime client needs. It deliberately
// omits contributors and participantCount, which the domain event does not
// carry; clients refetch the project when they need them.
type projectDTO struct {
	ID           string                    `json:"id"`
	Title        string                    `json:"title"`
	Status       string                    `json:"status"`
	Version      int                       `json:"version"`
	Image        *imageDTO                 `json:"image"`
	Placeholders map[string]placeholderDTO `json:"placeholders"`
	CreatedAt    time.Time                 `json:"createdAt"`
}

func peersDTO(in []domain.Peer) []peerDTO {
	out := make([]peerDTO, len(in))
	for i, p := range in {
		out[i] = peerDTO{ID: p.ID, DisplayName: p.DisplayName, Color: p.Color}
		if p.AvatarURL != "" {
			url := p.AvatarURL
			out[i].AvatarURL = &url
		}
	}
	return out
}

func rowPtr(id string) *string {
	if id == "" {
		return nil
	}
	return &id
}

func participantsDTO(in []domain.Participant) []participantDTO {
	out := make([]participantDTO, len(in))
	for i, p := range in {
		out[i] = participantDTO{
			ID: p.ID, ProjectID: p.ProjectID, Number: p.Number, Name: p.Name, Phone: p.Phone,
			Version: p.Version, UpdatedAt: p.UpdatedAt,
		}
	}
	return out
}

func placeholderOf(p domain.Placeholder) placeholderDTO {
	return placeholderDTO{
		Font: p.Font, Size: p.Size, Stroke: p.Stroke, Color: p.Color, StrokeColor: p.StrokeColor,
		Bold: p.Bold, Italic: p.Italic, Underline: p.Underline, X: p.X, Y: p.Y,
	}
}

func projectOf(p domain.Project) projectDTO {
	d := projectDTO{
		ID: p.ID, Title: p.Title, Status: string(p.Status), Version: p.Version, CreatedAt: p.CreatedAt,
		Placeholders: map[string]placeholderDTO{
			string(domain.PlaceholderNumber): placeholderOf(p.Placeholders.Number),
			string(domain.PlaceholderName):   placeholderOf(p.Placeholders.Name),
			string(domain.PlaceholderPhone):  placeholderOf(p.Placeholders.Phone),
		},
	}
	if p.Image != nil {
		version := p.Image.SHA256
		if len(version) > 8 {
			version = version[:8]
		}
		d.Image = &imageDTO{
			URL:  "/api/v1/projects/" + p.ID + "/image?v=" + version,
			Name: p.Image.Name, W: p.Image.Width, H: p.Image.Height, Bytes: p.Image.Bytes,
		}
	}
	return d
}

func encodeHello(s domain.RoomSnapshot) ([]byte, error) {
	f := helloFrame{
		T: frameHello, You: s.You, Peers: peersDTO(s.Peers),
		Cursors:    make(map[string]cursorDTO, len(s.Cursors)),
		Locks:      make(map[string]lockDTO, len(s.Locks)),
		ServerTime: s.ServerTime,
	}
	for uid, c := range s.Cursors {
		f.Cursors[uid] = cursorDTO{RowID: rowPtr(c.RowID), Field: c.Field}
	}
	for row, l := range s.Locks {
		f.Locks[row] = lockDTO{By: l.By, ExpiresAt: l.ExpiresAt}
	}
	return json.Marshal(f)
}

// encodeEvent serializes a hub or domain event as a server frame. Unknown
// event types are skipped (ok is false) instead of failing the connection.
func encodeEvent(ev domain.Event) (data []byte, ok bool, err error) {
	var f any
	switch e := ev.(type) {
	case domain.PresenceEvent:
		f = presenceFrame{T: framePresence, Peers: peersDTO(e.Peers)}
	case domain.CursorEvent:
		f = cursorFrame{T: frameCursor, UserID: e.UserID, RowID: rowPtr(e.Cursor.RowID), Field: e.Cursor.Field}
	case domain.LockedEvent:
		f = lockFrame{T: frameLock, RowID: e.RowID, By: e.By, ExpiresAt: e.ExpiresAt}
	case domain.UnlockedEvent:
		f = lockFrame{T: frameUnlock, RowID: e.RowID, By: e.By, ExpiresAt: e.ExpiresAt}
	case domain.RowsUpsertedEvent:
		f = rowsUpsertFrame{T: frameRowsUpsert, Items: participantsDTO(e.Items)}
	case domain.RowsDeletedEvent:
		ids := e.IDs
		if ids == nil {
			ids = []string{}
		}
		f = rowsDeleteFrame{T: frameRowsDelete, IDs: ids}
	case domain.ProjectUpdatedEvent:
		f = projectFrame{T: frameProjectUpd, Project: projectOf(e.Project)}
	case domain.ReauthEvent:
		f = reauthFrame{T: frameReauth}
	default:
		return nil, false, nil
	}
	data, err = json.Marshal(f)
	return data, err == nil, err
}

func encodeDenied(rowID, by string) ([]byte, error) {
	return json.Marshal(deniedFrame{T: frameLockDenied, RowID: rowID, By: by})
}

func encodeError(code, message string) []byte {
	// Marshaling a struct of strings cannot fail.
	b, _ := json.Marshal(errorFrame{T: frameError, Code: code, Message: message})
	return b
}

// validID accepts a short printable identifier for rowId.
func validID(s string, limit int) bool {
	if s == "" || len(s) > limit || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// pongFrame answers a ping so the client can tell a live connection from a half-open one.
var pongFrame = []byte(`{"t":"` + framePong + `"}`)
