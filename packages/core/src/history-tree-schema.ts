/** Expendable, content-addressed reductions. Never authoritative event data. */
export const historyTreeSchema=`
CREATE TABLE IF NOT EXISTS analytics_fold_nodes(key TEXT PRIMARY KEY,payload BLOB NOT NULL,bytes INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analytics_fold_edges(parent TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(parent,child)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS analytics_fold_edges_child ON analytics_fold_edges(child);
CREATE TABLE IF NOT EXISTS analytics_fold_roots(scope TEXT PRIMARY KEY,root TEXT NOT NULL,touched_at_ms INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analytics_fold_clock(leaf TEXT NOT NULL,day TEXT NOT NULL,session TEXT NOT NULL,person TEXT NOT NULL,lo INTEGER NOT NULL,hi INTEGER NOT NULL,PRIMARY KEY(leaf,day,session,person,lo)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analytics_report_fold_roots(cache_key TEXT PRIMARY KEY REFERENCES analytics_reports(cache_key) ON DELETE CASCADE,root TEXT NOT NULL) WITHOUT ROWID;
`;
export const foldLeavesSql=`WITH RECURSIVE nodes(key) AS(SELECT ? UNION SELECT e.child FROM analytics_fold_edges e JOIN nodes n ON e.parent=n.key)`;
