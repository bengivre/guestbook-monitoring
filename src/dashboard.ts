/**
 * Grafana dashboard for the Guestbook, delivered as a ConfigMap.
 * The Grafana sidecar shipped with kube-prometheus-stack auto-imports any
 * ConfigMap labelled `grafana_dashboard: "1"`, so no manual import is needed.
 *
 * Layout:
 *   Overview — HTTP + Apache workers (non-repeating)
 *   Redis — $role — repeating row (leader / follower)
 *   Frontend — pod restarts / CPU / memory
 */
export const guestbookDashboard = {
    title: "Guestbook Overview",
    uid: "guestbook-overview",
    editable: true,
    schemaVersion: 39,
    time: { from: "now-30m", to: "now" },
    refresh: "10s",
    templating: {
        list: [
            {
                name: "datasource",
                type: "datasource",
                query: "prometheus",
                current: { text: "Prometheus", value: "Prometheus" },
                hide: 0,
            },
            {
                name: "role",
                type: "query",
                // kube-prometheus-stack provisions this datasource with uid "prometheus".
                // Prefer a fixed uid over ${datasource} so the variable query always runs.
                datasource: { type: "prometheus", uid: "prometheus" },
                // Grafana 10+ ignores a bare string query; need definition + query object.
                definition: "label_values(redis_up, role)",
                query: {
                    qryType: 1,
                    query: "label_values(redis_up, role)",
                    refId: "PrometheusVariableQueryEditor-VariableQuery",
                },
                includeAll: true,
                multi: true,
                // So role=~"$role" matches everything when "All" is selected.
                allValue: ".*",
                refresh: 2,
                sort: 1,
                regex: "",
                options: [],
                current: { selected: true, text: "All", value: "$__all" },
                hide: 0,
            },
        ],
    },
    panels: [
        // ---- Overview (non-repeating) ----------------------------------------
        {
            id: 1,
            title: "HTTP request rate (frontend)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 0 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(apache_accesses_total[1m]))",
                legendFormat: "HTTP req/s",
            }],
        },
        {
            id: 4,
            title: "Apache busy workers",
            type: "stat",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 0 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(apache_workers{state=\"busy\"})",
                legendFormat: "busy",
            }],
        },
        // ---- Redis (repeating row per role) ----------------------------------
        {
            id: 10,
            type: "row",
            title: "Redis — $role",
            repeat: "role",
            collapsed: false,
            gridPos: { h: 1, w: 24, x: 0, y: 8 },
        },
        {
            id: 2,
            title: "Redis commands processed (req/s)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 9 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum by (role) (rate(redis_commands_processed_total{role=~\"$role\"}[1m]))",
                legendFormat: "{{role}}",
            }],
        },
        {
            id: 3,
            title: "Redis connected clients",
            type: "stat",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 9 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum by (role) (redis_connected_clients{role=~\"$role\"})",
                legendFormat: "{{role}}",
            }],
        },
        {
            id: 5,
            title: "Redis rejected connections (errors/s)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 17 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum by (role) (rate(redis_rejected_connections_total{role=~\"$role\"}[1m]))",
                legendFormat: "{{role}}",
            }],
        },
        {
            id: 6,
            title: "Redis memory usage",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 17 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum by (role) (redis_memory_used_bytes{role=~\"$role\"})",
                legendFormat: "{{role}}",
            }],
        },
        // ---- Frontend resources (non-repeating) ------------------------------
        {
            id: 11,
            type: "row",
            title: "Frontend",
            collapsed: false,
            gridPos: { h: 1, w: 24, x: 0, y: 25 },
        },
        {
            id: 7,
            title: "Frontend pod restarts",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 0, y: 26 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(kube_pod_container_status_restarts_total{namespace=\"guestbook\", pod=~\"frontend-.*\"}) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 8,
            title: "Frontend pod CPU (cores)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 8, y: 26 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(container_cpu_usage_seconds_total{namespace=\"guestbook\", pod=~\"frontend-.*\", container=\"php-redis\"}[1m])) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 9,
            title: "Frontend pod memory (bytes)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 16, y: 26 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(container_memory_working_set_bytes{namespace=\"guestbook\", pod=~\"frontend-.*\", container=\"php-redis\"}) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
    ],
};
