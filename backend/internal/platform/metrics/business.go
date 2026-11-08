package metrics

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Label values pre-created at startup so that rate() and dashboards see a series before the
// first event.
var (
	refreshResults = []string{"ok", "idempotent_replay", "reuse_detected", "invalid", "error"}
	loginResults   = []string{"ok", "bad_credentials", "rate_limited", "error"}
	uploadKinds    = []string{"project_image", "avatar"}
	uploadResults  = []string{"ok", "rejected", "error"}
	rateLimitKinds = []string{"login", "client_errors", "api", "ws"}
	queryKinds     = []string{"select", "insert", "update", "delete", "tx", "other"}
	blacklistKinds = []string{"ok", "revoked", "error"}
)

func (m *Metrics) initLabels() {
	for _, v := range refreshResults {
		m.TokenRefresh.WithLabelValues(v)
	}
	for _, v := range loginResults {
		m.Logins.WithLabelValues(v)
	}
	for _, v := range blacklistKinds {
		m.BlacklistChecks.WithLabelValues(v)
	}
	for _, k := range uploadKinds {
		for _, r := range uploadResults {
			m.Uploads.WithLabelValues(k, r)
		}
	}
	for _, k := range rateLimitKinds {
		m.RateLimited.WithLabelValues(k)
	}
	for _, k := range queryKinds {
		m.queryDuration.WithLabelValues(k)
	}
}

// rateLimitKind classifies a throttled HTTP response by route pattern. The set is fixed, so
// the label stays bounded whatever the routes are.
func rateLimitKind(route string) string {
	switch {
	case strings.HasSuffix(route, "/auth/login"):
		return "login"
	case strings.HasSuffix(route, "/client-errors"):
		return "client_errors"
	default:
		return "api"
	}
}

// ObserveQuery records one database statement. kind is the value returned by QueryKind.
func (m *Metrics) ObserveQuery(kind string, d time.Duration) {
	m.queryDuration.WithLabelValues(kind).Observe(d.Seconds())
}

// QueryKind maps SQL text onto the small fixed set of statement kinds used as the query label.
// Statement text never becomes a label value.
func QueryKind(sql string) string {
	s := strings.TrimLeft(sql, " \t\r\n(")
	end := strings.IndexAny(s, " \t\r\n;(")
	if end < 0 {
		end = len(s)
	}
	switch strings.ToLower(s[:end]) {
	case "select", "with":
		return "select"
	case "insert":
		return "insert"
	case "update":
		return "update"
	case "delete":
		return "delete"
	case "begin", "commit", "rollback":
		return "tx"
	default:
		return "other"
	}
}

// RegisterLocks exposes the number of live realtime row locks, read at scrape time.
func (m *Metrics) RegisterLocks(active func() int) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "tip_ws_locks_active",
		Help: "Row locks currently held by realtime clients.",
	}, func() float64 { return float64(active()) }))
}

// StorageProbes are the data sources of the storage gauges. Every probe is optional.
type StorageProbes struct {
	// DataDir is DATA_DIR; the uploads size is measured below DataDir/uploads.
	DataDir string
	// DiskFree reports free and total bytes of the volume holding path.
	DiskFree func(path string) (free, total uint64, err error)
	// DirSize sums the file sizes below root.
	DirSize func(ctx context.Context, root string) (int64, error)
	// DBSize returns the database size in bytes.
	DBSize func(ctx context.Context) (int64, error)
	// TTL is how long the directory walk and the database size are reused; zero means 60 s.
	TTL time.Duration
	// Timeout bounds one refresh pass; zero means 2 s.
	Timeout time.Duration
	// Now overrides time.Now in tests.
	Now func() time.Time
}

// RegisterStorage exposes tip_data_dir_free_bytes, tip_uploads_bytes and tip_db_size_bytes.
// Values are computed at scrape time. The expensive ones (the uploads walk and the database
// size query) are cached for TTL, so a scrape every 15 s never repeats them; a failed refresh
// keeps the previous value instead of dropping the series.
func (m *Metrics) RegisterStorage(p StorageProbes) {
	if p.TTL <= 0 {
		p.TTL = 60 * time.Second
	}
	if p.Timeout <= 0 {
		p.Timeout = 2 * time.Second
	}
	if p.Now == nil {
		p.Now = time.Now
	}
	m.Registry.MustRegister(&storageCollector{
		p:       p,
		free:    prometheus.NewDesc("tip_data_dir_free_bytes", "Free bytes on the volume holding the data directory.", nil, nil),
		uploads: prometheus.NewDesc("tip_uploads_bytes", "Total size of stored upload files.", nil, nil),
		dbSize:  prometheus.NewDesc("tip_db_size_bytes", "On-disk size of the database.", nil, nil),
	})
}

type cached struct {
	val float64
	at  time.Time
	ok  bool
}

type storageCollector struct {
	p                     StorageProbes
	free, uploads, dbSize *prometheus.Desc

	mu                sync.Mutex
	uploadsC, dbSizeC cached
}

func (c *storageCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.free
	ch <- c.uploads
	ch <- c.dbSize
}

func (c *storageCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), c.p.Timeout)
	defer cancel()
	now := c.p.Now()

	if c.p.DiskFree != nil {
		if free, _, err := c.p.DiskFree(c.p.DataDir); err == nil {
			ch <- prometheus.MustNewConstMetric(c.free, prometheus.GaugeValue, float64(free))
		}
	}
	if c.p.DirSize != nil {
		c.refresh(&c.uploadsC, now, func() (int64, error) {
			return c.p.DirSize(ctx, filepath.Join(c.p.DataDir, "uploads"))
		})
		if c.uploadsC.ok {
			ch <- prometheus.MustNewConstMetric(c.uploads, prometheus.GaugeValue, c.uploadsC.val)
		}
	}
	if c.p.DBSize != nil {
		c.refresh(&c.dbSizeC, now, func() (int64, error) { return c.p.DBSize(ctx) })
		if c.dbSizeC.ok {
			ch <- prometheus.MustNewConstMetric(c.dbSize, prometheus.GaugeValue, c.dbSizeC.val)
		}
	}
}

// refresh recomputes v when it is older than the TTL. On failure the old value stays, and the
// attempt time still advances so a broken probe is retried once per TTL, not once per scrape.
func (c *storageCollector) refresh(v *cached, now time.Time, probe func() (int64, error)) {
	if !v.at.IsZero() && now.Sub(v.at) < c.p.TTL {
		return
	}
	v.at = now
	if n, err := probe(); err == nil {
		v.val, v.ok = float64(n), true
	}
}
