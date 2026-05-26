/*
 * U-CH-5: OTLP HTTP/JSON metric emitter for C bench.
 *
 * Build: gcc -O2 -pthread -c otel_emit.c
 * Link:  -lcurl
 *
 * Endpoint (env OTEL_EXPORTER_OTLP_ENDPOINT or default 127.0.0.1:4318):
 *   POST $ENDPOINT/v1/metrics  Content-Type: application/json
 *
 * Wire format follows OTLP/JSON spec (resourceMetrics → scopeMetrics →
 * metrics). We emit three metrics every 5s:
 *   - tsp.bmt.cbench.ops          Sum (delta) — count of successful tx
 *   - tsp.bmt.cbench.errs         Sum (delta) — count of errors
 *   - tsp.bmt.cbench.duration_ns  Sum (cumulative) — total tx ns observed
 * No histogram: live bench feed only needs throughput; final percentiles
 * live in the parquet that v3_to_parquet.py writes once per cell.
 */
#define _GNU_SOURCE
#include "otel_emit.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <curl/curl.h>

#define TICK_INTERVAL_S 5

/* Explicit histogram buckets (upper bounds, milliseconds). HSM ops on hsm2m
 * cluster: GCM-256B ~0.3ms, KWP unwrap ~3-5ms, GCM-1024B ~0.6ms, GCM with
 * ENA throttle ~10-50ms. Buckets sized to capture both tail and median. */
#define BUCKETS_N 14
static const double BUCKET_BOUNDS_MS[BUCKETS_N] = {
    0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0,
    /* +Inf last — not stored as a bound; bucket index = BUCKETS_N-1 catches >=1000ms */
    1.0e18
};

struct otel_ctx {
    char endpoint[512];
    char run_id[128];
    char process_idx[16];
    char unit_id[160];
    char family[32];
    char algorithm[16];
    char mode[16];
    int  payload_size;
    int  cluster_size;
    char variant[16];

    /* Lock-free counters. Background thread reads + atomically resets the
     * delta counters; cumulative_dur_ns is monotone (we send absolute on
     * each tick, OTLP receiver computes delta). */
    atomic_long delta_ops;
    atomic_long delta_errs;
    atomic_long cumulative_dur_ns;
    /* Cumulative ops/errs accumulated across ticks (read+update on the
     * single bg thread; not atomic — only the bg thread mutates these). */
    long cum_ops;
    long cum_errs;

    /* Cumulative histogram: each bucket is a counter of ops with duration
     * <= BUCKET_BOUNDS_MS[i]. Fast path increments atomically; bg thread
     * reads (no reset — cumulative semantic). */
    atomic_long bucket_counts[BUCKETS_N];

    pthread_t   thread;
    atomic_int  stop;
    atomic_int  fail_logged;       /* one-shot log on emission failure */
};

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long)ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static long now_ns_realtime(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long)ts.tv_sec * 1000000000L + ts.tv_nsec;
}

/* JSON-escape a string into dst. dst_cap should be ~ 2x src + 1.
 * Returns characters written (excluding NUL). */
static size_t json_escape(char *dst, size_t dst_cap, const char *src) {
    size_t o = 0;
    if (!src) src = "";
    for (size_t i = 0; src[i] && o + 6 < dst_cap; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"' || c == '\\') { dst[o++] = '\\'; dst[o++] = (char)c; }
        else if (c == '\n')         { dst[o++] = '\\'; dst[o++] = 'n'; }
        else if (c < 0x20)          { o += (size_t)snprintf(dst + o, dst_cap - o, "\\u%04x", c); }
        else                         dst[o++] = (char)c;
    }
    if (o < dst_cap) dst[o] = '\0';
    return o;
}

/* Build one OTLP datapoint attribute set as JSON (run_id, process_idx, etc.). */
static int build_attrs(const otel_ctx *c, char *buf, size_t cap) {
    char unit_e[256], fam_e[64], alg_e[32], mode_e[32], var_e[32];
    json_escape(unit_e, sizeof unit_e, c->unit_id);
    json_escape(fam_e,  sizeof fam_e,  c->family);
    json_escape(alg_e,  sizeof alg_e,  c->algorithm);
    json_escape(mode_e, sizeof mode_e, c->mode);
    json_escape(var_e,  sizeof var_e,  c->variant);
    return snprintf(buf, cap,
        "[{\"key\":\"run_id\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"process_idx\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"unit_id\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"family\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"algorithm\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"mode\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"payload_size\",\"value\":{\"intValue\":%d}},"
        "{\"key\":\"cluster_size\",\"value\":{\"intValue\":%d}},"
        "{\"key\":\"variant\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"phase\",\"value\":{\"stringValue\":\"measure\"}}]",
        c->run_id, c->process_idx, unit_e, fam_e, alg_e, mode_e,
        c->payload_size, c->cluster_size, var_e);
}

/* Build the resource attribute set (service.name, service.instance.id, tsp.run_id, tsp.process_idx). */
static int build_resource(const otel_ctx *c, char *buf, size_t cap) {
    return snprintf(buf, cap,
        "[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"hsm-bmt-c-bench\"}},"
        "{\"key\":\"service.instance.id\",\"value\":{\"stringValue\":\"hsm-bmt-c-bench-%s\"}},"
        "{\"key\":\"tsp.run_id\",\"value\":{\"stringValue\":\"%s\"}},"
        "{\"key\":\"tsp.process_idx\",\"value\":{\"stringValue\":\"%s\"}}]",
        c->process_idx, c->run_id, c->process_idx);
}

/* Build one Sum metric JSON fragment for the given counter. */
static int build_sum_metric(char *buf, size_t cap,
                            const char *name, const char *unit,
                            int is_cumulative, long value,
                            long start_ns, long now_ns,
                            const char *attrs) {
    return snprintf(buf, cap,
        "{\"name\":\"%s\",\"unit\":\"%s\",\"sum\":{"
        "\"aggregationTemporality\":%d,\"isMonotonic\":true,"
        "\"dataPoints\":[{"
        "\"asInt\":%ld,"
        "\"startTimeUnixNano\":\"%ld\","
        "\"timeUnixNano\":\"%ld\","
        "\"attributes\":%s"
        "}]}}",
        name, unit,
        is_cumulative ? 2 : 1,    /* 1=DELTA, 2=CUMULATIVE per OTLP spec */
        value, start_ns, now_ns, attrs);
}

/* Build one Histogram metric JSON fragment (cumulative, OTLP explicit
 * bucket histogram). bucket_counts[i] is the per-bucket count of
 * observations whose duration falls in (bound[i-1], bound[i]]
 * (bucket 0 = (0, bound[0]]; last bucket = (bound[N-2], +Inf)).
 * OTLP bucketCounts is exactly this per-bucket form, so no
 * differentiation is needed. */
static int build_histogram_metric(char *buf, size_t cap,
                                  long total_count, long sum_ms,
                                  const long per_bucket[BUCKETS_N],
                                  long start_ns, long now_ns,
                                  const char *attrs) {
    /* Build "explicitBounds":[0.1,0.25,...,1000.0] — exclude the +Inf
     * sentinel (last entry of BUCKET_BOUNDS_MS). OTLP convention: N
     * bounds → N+1 bucketCounts (last bucket is implicit > last bound).
     * We keep BUCKETS_N total bucketCounts and BUCKETS_N-1 bounds. */
    char bounds[256];
    int bo = 0;
    bo += snprintf(bounds + bo, sizeof bounds - bo, "[");
    for (int i = 0; i < BUCKETS_N - 1; i++) {
        bo += snprintf(bounds + bo, sizeof bounds - bo, "%s%g",
                       i == 0 ? "" : ",", BUCKET_BOUNDS_MS[i]);
    }
    bo += snprintf(bounds + bo, sizeof bounds - bo, "]");

    char counts[512];
    int co = 0;
    co += snprintf(counts + co, sizeof counts - co, "[");
    for (int i = 0; i < BUCKETS_N; i++) {
        co += snprintf(counts + co, sizeof counts - co, "%s\"%ld\"",
                       i == 0 ? "" : ",", per_bucket[i]);
    }
    co += snprintf(counts + co, sizeof counts - co, "]");

    return snprintf(buf, cap,
        "{\"name\":\"tsp.bmt.cbench.duration\",\"unit\":\"ms\",\"histogram\":{"
        "\"aggregationTemporality\":2,"  /* CUMULATIVE */
        "\"dataPoints\":[{"
        "\"count\":\"%ld\","
        "\"sum\":%ld,"
        "\"bucketCounts\":%s,"
        "\"explicitBounds\":%s,"
        "\"startTimeUnixNano\":\"%ld\","
        "\"timeUnixNano\":\"%ld\","
        "\"attributes\":%s"
        "}]}}",
        total_count, sum_ms, counts, bounds, start_ns, now_ns, attrs);
}

/* Find the bucket index for a duration in ns. Returns smallest i such
 * that ns <= BUCKET_BOUNDS_MS[i] * 1e6. Linear scan — BUCKETS_N=14 is
 * cache-friendly and faster than binary search at this size. */
static int bucket_index_for_ns(long ns) {
    for (int i = 0; i < BUCKETS_N - 1; i++) {
        if ((double)ns <= BUCKET_BOUNDS_MS[i] * 1.0e6) return i;
    }
    return BUCKETS_N - 1;
}

static int emit_tick(otel_ctx *c, long start_ns,
                     long delta_ops, long delta_errs, long cum_dur_ns) {
    char attrs[1024];
    char resource[512];
    build_attrs(c, attrs, sizeof attrs);
    build_resource(c, resource, sizeof resource);

    /* CUMULATIVE Sum: ADOT prometheusremotewrite drops DELTA Sum metrics
     * during translation (otelcol_exporter_prometheusremotewrite_
     * failed_translations counter — observed 100% drop rate 2026-05-22).
     * Prometheus speaks cumulative natively. Accept the lost delta
     * semantic; Grafana can still compute rate() over the counter. */
    c->cum_ops  += delta_ops;
    c->cum_errs += delta_errs;

    char m_ops[1536], m_errs[1536], m_dur[1536], m_hist[3072];
    long now_ns = now_ns_realtime();
    build_sum_metric(m_ops,  sizeof m_ops,
        "tsp.bmt.cbench.ops",          "1",  1, c->cum_ops,  start_ns, now_ns, attrs);
    build_sum_metric(m_errs, sizeof m_errs,
        "tsp.bmt.cbench.errs",         "1",  1, c->cum_errs, start_ns, now_ns, attrs);
    build_sum_metric(m_dur,  sizeof m_dur,
        "tsp.bmt.cbench.duration_ns",  "ns", 1, cum_dur_ns,  start_ns, now_ns, attrs);

    /* Snapshot histogram buckets and build explicit-bucket Histogram. */
    long buckets[BUCKETS_N];
    for (int i = 0; i < BUCKETS_N; i++) {
        buckets[i] = atomic_load(&c->bucket_counts[i]);
    }
    long hist_count = c->cum_ops;          /* total observations */
    long hist_sum_ms = cum_dur_ns / 1000000L;  /* ns → ms, rounded down */
    build_histogram_metric(m_hist, sizeof m_hist,
        hist_count, hist_sum_ms, buckets, start_ns, now_ns, attrs);

    char body[12288];
    int n = snprintf(body, sizeof body,
        "{\"resourceMetrics\":[{"
        "\"resource\":{\"attributes\":%s},"
        "\"scopeMetrics\":[{"
        "\"scope\":{\"name\":\"tsp.bmt.cbench\"},"
        "\"metrics\":[%s,%s,%s,%s]}]}]}",
        resource, m_ops, m_errs, m_dur, m_hist);
    if (n < 0 || (size_t)n >= sizeof body) return -1;

    CURL *curl = curl_easy_init();
    if (!curl) return -1;
    char url[640];
    snprintf(url, sizeof url, "%s/v1/metrics", c->endpoint);
    struct curl_slist *hdrs = NULL;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)n);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 3L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    /* Discard response body — we don't care what the collector says. */
    FILE *devnull = fopen("/dev/null", "w");
    if (devnull) curl_easy_setopt(curl, CURLOPT_WRITEDATA, devnull);

    CURLcode rc = curl_easy_perform(curl);
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);
    if (devnull) fclose(devnull);

    if (rc != CURLE_OK || http_code < 200 || http_code >= 300) {
        if (atomic_exchange(&c->fail_logged, 1) == 0) {
            fprintf(stderr, "otel_emit: first failure rc=%d http=%ld endpoint=%s\n",
                    (int)rc, http_code, c->endpoint);
        }
        return -1;
    }
    return 0;
}

static void *otel_loop(void *arg) {
    otel_ctx *c = (otel_ctx *)arg;
    long start_ns = now_ns_realtime();
    while (!atomic_load(&c->stop)) {
        /* sleep in 100ms slices so stop is responsive */
        for (int i = 0; i < TICK_INTERVAL_S * 10; i++) {
            if (atomic_load(&c->stop)) break;
            usleep(100 * 1000);
        }
        long d_ops  = atomic_exchange(&c->delta_ops, 0);
        long d_errs = atomic_exchange(&c->delta_errs, 0);
        long cum    = atomic_load(&c->cumulative_dur_ns);
        emit_tick(c, start_ns, d_ops, d_errs, cum);
    }
    /* one final tick on shutdown so the last few seconds aren't lost */
    long d_ops  = atomic_exchange(&c->delta_ops, 0);
    long d_errs = atomic_exchange(&c->delta_errs, 0);
    long cum    = atomic_load(&c->cumulative_dur_ns);
    emit_tick(c, start_ns, d_ops, d_errs, cum);
    return NULL;
}

/* ---- public API ---- */

static void copy_clipped(char *dst, size_t cap, const char *src) {
    if (!src) src = "";
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

otel_ctx *otel_init(
    const char *run_id, const char *process_idx,
    const char *unit_id, const char *family,
    const char *algorithm, const char *mode,
    int payload_size, int cluster_size,
    const char *variant) {
    if (!run_id || !*run_id) return NULL;
    /* Don't blow up if curl init was never called process-wide; libcurl
     * does lazy init in curl_easy_init() but it's safer to do it once. */
    static int curl_global = 0;
    if (!curl_global) { curl_global_init(CURL_GLOBAL_DEFAULT); curl_global = 1; }

    otel_ctx *c = calloc(1, sizeof(*c));
    if (!c) return NULL;
    const char *ep = getenv("OTEL_EXPORTER_OTLP_ENDPOINT");
    copy_clipped(c->endpoint, sizeof c->endpoint, ep && *ep ? ep : "http://127.0.0.1:4318");
    copy_clipped(c->run_id,      sizeof c->run_id,      run_id);
    copy_clipped(c->process_idx, sizeof c->process_idx, process_idx ? process_idx : "0");
    copy_clipped(c->unit_id,     sizeof c->unit_id,     unit_id ? unit_id : "");
    copy_clipped(c->family,      sizeof c->family,      family ? family : "");
    copy_clipped(c->algorithm,   sizeof c->algorithm,   algorithm ? algorithm : "");
    copy_clipped(c->mode,        sizeof c->mode,        mode ? mode : "");
    copy_clipped(c->variant,     sizeof c->variant,     variant ? variant : "NA");
    c->payload_size = payload_size;
    c->cluster_size = cluster_size;
    atomic_store(&c->delta_ops, 0);
    atomic_store(&c->delta_errs, 0);
    atomic_store(&c->cumulative_dur_ns, 0);
    for (int i = 0; i < BUCKETS_N; i++) atomic_store(&c->bucket_counts[i], 0);
    atomic_store(&c->stop, 0);
    atomic_store(&c->fail_logged, 0);

    if (pthread_create(&c->thread, NULL, otel_loop, c) != 0) {
        free(c);
        return NULL;
    }
    fprintf(stderr, "otel_emit: enabled endpoint=%s runId=%s processIdx=%s unitId=%s\n",
            c->endpoint, c->run_id, c->process_idx, c->unit_id);
    return c;
}

void otel_record_op(otel_ctx *c, long ns) {
    if (!c) return;
    atomic_fetch_add(&c->delta_ops, 1);
    atomic_fetch_add(&c->cumulative_dur_ns, ns);
    int bi = bucket_index_for_ns(ns);
    atomic_fetch_add(&c->bucket_counts[bi], 1);
}

void otel_record_err(otel_ctx *c) {
    if (!c) return;
    atomic_fetch_add(&c->delta_errs, 1);
}

void otel_close(otel_ctx *c) {
    if (!c) return;
    atomic_store(&c->stop, 1);
    pthread_join(c->thread, NULL);
    free(c);
}

/* now_ms is currently unused outside debug logs — keep linker happy by
 * marking it static and letting the compiler drop it under -O2. */
static __attribute__((unused)) long _otel_emit_unused_silencer(void) { return now_ms(); }
