/*
 * PER_CALL native PKCS#11 bench against CloudHSM SDK 5.
 *
 * C-language counterpart to PerCallOperationsCloudHsmKekReuse.java. Per
 * v3-final scenarios (PER_CALL family) the unit of work is one AES op
 * against a token-resident KEK (BMT_KEK_AES{128,256}); the matrix sweeps
 * (algo, mode, payload).
 *
 * Per-tx (no session/key churn — matches Java KEK-reuse path):
 *   1) for ECB/CBC/CTR/GCM:  C_EncryptInit(<mech>, kek) + C_Encrypt(payload)
 *      for CMAC:             C_SignInit(CKM_AES_CMAC, kek) + C_Sign(payload)
 *   2) freshly randomized IV per tx where mode requires (CBC, CTR);
 *      GCM uses the SDK 5 convention of pIv=zero buffer + ulIvBits=0
 *      to request server-side IV generation.
 *
 * One session per worker (opened once, kept open till stop). KEK is looked
 * up once at startup via C_FindObjects on the setup session and the handle
 * is shared across worker threads (token-resident object — handle valid
 * cluster-wide on SDK 5).
 *
 * Build:  gcc -O2 -pthread -o /tmp/per_call_bench /tmp/per_call_bench.c -ldl
 * Run:    CLOUDHSM_PIN=bmt_cu:$PW \
 *           /tmp/per_call_bench --threads N --seconds S \
 *             --algo aes_128|aes_256 --mode ecb|cbc|ctr|gcm|cmac \
 *             --payload 256|1024
 *
 * Output (stdout) matches v3-bench-wrapper.sh aggregator expectations:
 *   threads=N seconds=S tx=...
 *   tx_per_sec=...
 *   p50_ms=... p95_ms=... p99_ms=... (n=...)
 *   sample CMAC/CT first 32B (stderr only — for visual sanity)
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>
#include <stdatomic.h>

/* U-CH-5: optional OTLP HTTP/JSON live-tick emitter. Compiled out if
 * HSM_BMT_NO_OTEL is defined (allows --threads smoke runs without libcurl). */
#ifndef HSM_BMT_NO_OTEL
#include "otel_emit.h"
#else
typedef struct otel_ctx otel_ctx;
static inline otel_ctx *otel_init(const char *a, const char *b, const char *c,
    const char *d, const char *e, const char *f, int g, int h, const char *i) {
    (void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i; return NULL;
}
static inline void otel_record_op(otel_ctx *c, long ns) { (void)c;(void)ns; }
static inline void otel_record_err(otel_ctx *c) { (void)c; }
static inline void otel_close(otel_ctx *c) { (void)c; }
#endif

/* ---- minimal PKCS#11 v2.40 surface ---- */
typedef unsigned long CK_ULONG;
typedef CK_ULONG CK_RV;
typedef CK_ULONG CK_OBJECT_HANDLE;
typedef CK_ULONG CK_SESSION_HANDLE;
typedef CK_ULONG CK_SLOT_ID;
typedef CK_ULONG CK_FLAGS;
typedef CK_ULONG CK_USER_TYPE;
typedef CK_ULONG CK_MECHANISM_TYPE;
typedef CK_ULONG CK_ATTRIBUTE_TYPE;
typedef CK_ULONG CK_OBJECT_CLASS;
typedef unsigned char CK_BYTE;
typedef CK_BYTE *CK_BYTE_PTR;
typedef CK_ULONG *CK_ULONG_PTR;
typedef void *CK_VOID_PTR;
typedef char *CK_UTF8CHAR_PTR;

#define CKR_OK                       0x00000000UL
#define CKR_USER_ALREADY_LOGGED_IN   0x00000100UL
#define CKU_USER                     1UL
#define CKF_SERIAL_SESSION           0x00000004UL
#define CKF_RW_SESSION               0x00000002UL
#define CKO_SECRET_KEY               0x00000004UL

#define CKA_CLASS                    0x00000000UL
#define CKA_LABEL                    0x00000003UL

#define CKM_AES_ECB                  0x00001081UL
#define CKM_AES_CBC                  0x00001082UL
#define CKM_AES_CTR                  0x00001086UL
#define CKM_AES_GCM                  0x00001087UL
#define CKM_AES_CMAC                 0x0000108AUL

typedef struct CK_ATTRIBUTE {
    CK_ATTRIBUTE_TYPE type;
    CK_VOID_PTR pValue;
    CK_ULONG ulValueLen;
} CK_ATTRIBUTE;

typedef struct CK_MECHANISM {
    CK_MECHANISM_TYPE mechanism;
    CK_VOID_PTR pParameter;
    CK_ULONG ulParameterLen;
} CK_MECHANISM;

/* AES-CTR params (PKCS#11 §6.6) — CKM_AES_CTR uses CK_AES_CTR_PARAMS */
typedef struct CK_AES_CTR_PARAMS {
    CK_ULONG ulCounterBits;
    CK_BYTE  cb[16];
} CK_AES_CTR_PARAMS;

/* AES-GCM params — SDK 5 convention: pIv zero-buf + ulIvBits=0 → HSM-generated IV */
typedef struct CK_GCM_PARAMS {
    CK_BYTE_PTR pIv;
    CK_ULONG ulIvLen;
    CK_ULONG ulIvBits;
    CK_BYTE_PTR pAAD;
    CK_ULONG ulAADLen;
    CK_ULONG ulTagBits;
} CK_GCM_PARAMS;

typedef CK_RV (*pC_Initialize)(CK_VOID_PTR);
typedef CK_RV (*pC_GetSlotList)(unsigned char, CK_SLOT_ID *, CK_ULONG_PTR);
typedef CK_RV (*pC_OpenSession)(CK_SLOT_ID, CK_FLAGS, CK_VOID_PTR, CK_VOID_PTR, CK_SESSION_HANDLE*);
typedef CK_RV (*pC_CloseSession)(CK_SESSION_HANDLE);
typedef CK_RV (*pC_Login)(CK_SESSION_HANDLE, CK_USER_TYPE, CK_UTF8CHAR_PTR, CK_ULONG);
typedef CK_RV (*pC_FindObjectsInit)(CK_SESSION_HANDLE, CK_ATTRIBUTE *, CK_ULONG);
typedef CK_RV (*pC_FindObjects)(CK_SESSION_HANDLE, CK_OBJECT_HANDLE *, CK_ULONG, CK_ULONG_PTR);
typedef CK_RV (*pC_FindObjectsFinal)(CK_SESSION_HANDLE);
typedef CK_RV (*pC_EncryptInit)(CK_SESSION_HANDLE, CK_MECHANISM*, CK_OBJECT_HANDLE);
typedef CK_RV (*pC_Encrypt)(CK_SESSION_HANDLE, CK_BYTE*, CK_ULONG, CK_BYTE*, CK_ULONG_PTR);
typedef CK_RV (*pC_SignInit)(CK_SESSION_HANDLE, CK_MECHANISM*, CK_OBJECT_HANDLE);
typedef CK_RV (*pC_Sign)(CK_SESSION_HANDLE, CK_BYTE*, CK_ULONG, CK_BYTE*, CK_ULONG_PTR);

#define DECL(sym) static p##sym f_##sym;
DECL(C_Initialize)
DECL(C_GetSlotList)
DECL(C_OpenSession)
DECL(C_CloseSession)
DECL(C_Login)
DECL(C_FindObjectsInit)
DECL(C_FindObjects)
DECL(C_FindObjectsFinal)
DECL(C_EncryptInit)
DECL(C_Encrypt)
DECL(C_SignInit)
DECL(C_Sign)
#undef DECL

/* ---- config ---- */
static CK_SLOT_ID g_slot;
static int g_threads = 64;
static int g_seconds = 360;
static const char *g_algo = "aes_256";
static const char *g_mode = "ecb";
static int g_payload = 1024;
static int g_keybits = 256;
static const char *g_kek_label = "BMT_KEK_AES256";
static CK_OBJECT_HANDLE g_kek = 0;
/* U-CH-5: identifying labels for OTel emission. process_idx default "0"
 * keeps single-process invocations valid; wrapper passes per-proc. */
static const char *g_run_id = "";
static const char *g_unit_id = "";
static const char *g_process_idx = "0";
static int g_cluster_size = 0;
static otel_ctx *g_otel = NULL;

static volatile int g_stop = 0;
static atomic_long g_ops = 0;
static atomic_long g_errs = 0;
static atomic_int g_sample_logged = 0;

#define SAMPLE_CAP 200000
typedef struct { long *samples; int n; } sample_buf;

static long now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long)ts.tv_sec * 1000000000L + ts.tv_nsec;
}

static int cmp_long(const void *a, const void *b) {
    long la = *(const long *)a, lb = *(const long *)b;
    return la < lb ? -1 : la > lb ? 1 : 0;
}

/* mode dispatch — set at parse time */
typedef enum { M_ECB, M_CBC, M_CTR, M_GCM, M_CMAC } mode_t_e;
static mode_t_e g_mode_e = M_ECB;

/* one tx; returns 0 on success, non-zero on error (out of session etc.) */
static int do_tx(CK_SESSION_HANDLE sess,
                 CK_BYTE *payload, CK_ULONG payload_len,
                 CK_BYTE *out, CK_ULONG out_cap) {
    CK_RV rv;
    CK_ULONG out_len = out_cap;
    CK_MECHANISM mech;
    CK_BYTE iv[16];

    switch (g_mode_e) {
        case M_ECB: {
            mech.mechanism = CKM_AES_ECB;
            mech.pParameter = NULL;
            mech.ulParameterLen = 0;
            rv = f_C_EncryptInit(sess, &mech, g_kek);
            if (rv != CKR_OK) return (int)rv;
            rv = f_C_Encrypt(sess, payload, payload_len, out, &out_len);
            if (rv != CKR_OK) return (int)rv;
            break;
        }
        case M_CBC: {
            if (getrandom(iv, 16, 0) != 16) return -1;
            mech.mechanism = CKM_AES_CBC;
            mech.pParameter = iv;
            mech.ulParameterLen = 16;
            rv = f_C_EncryptInit(sess, &mech, g_kek);
            if (rv != CKR_OK) return (int)rv;
            rv = f_C_Encrypt(sess, payload, payload_len, out, &out_len);
            if (rv != CKR_OK) return (int)rv;
            break;
        }
        case M_CTR: {
            CK_AES_CTR_PARAMS ctr;
            ctr.ulCounterBits = 32;  /* low 32 bits act as the counter; matches Java path */
            if (getrandom(ctr.cb, 12, 0) != 12) return -1;
            ctr.cb[12] = ctr.cb[13] = ctr.cb[14] = ctr.cb[15] = 0;
            mech.mechanism = CKM_AES_CTR;
            mech.pParameter = &ctr;
            mech.ulParameterLen = sizeof(ctr);
            rv = f_C_EncryptInit(sess, &mech, g_kek);
            if (rv != CKR_OK) return (int)rv;
            rv = f_C_Encrypt(sess, payload, payload_len, out, &out_len);
            if (rv != CKR_OK) return (int)rv;
            break;
        }
        case M_GCM: {
            /* CloudHSM SDK 5: pIv must be a zero-filled 12-byte buffer and
             * ulIvBits=0, which tells the HSM to generate the IV. The HSM
             * writes the generated IV into pIv on return. */
            CK_BYTE gcm_iv[12] = {0};
            CK_GCM_PARAMS gcm;
            gcm.pIv = gcm_iv;
            gcm.ulIvLen = 12;
            gcm.ulIvBits = 0;
            gcm.pAAD = NULL;
            gcm.ulAADLen = 0;
            gcm.ulTagBits = 128;
            mech.mechanism = CKM_AES_GCM;
            mech.pParameter = &gcm;
            mech.ulParameterLen = sizeof(gcm);
            rv = f_C_EncryptInit(sess, &mech, g_kek);
            if (rv != CKR_OK) return (int)rv;
            /* GCM ciphertext = payload + 16-byte tag */
            rv = f_C_Encrypt(sess, payload, payload_len, out, &out_len);
            if (rv != CKR_OK) return (int)rv;
            break;
        }
        case M_CMAC: {
            mech.mechanism = CKM_AES_CMAC;
            mech.pParameter = NULL;
            mech.ulParameterLen = 0;
            rv = f_C_SignInit(sess, &mech, g_kek);
            if (rv != CKR_OK) return (int)rv;
            out_len = 16;
            rv = f_C_Sign(sess, payload, payload_len, out, &out_len);
            if (rv != CKR_OK) return (int)rv;
            break;
        }
    }

    if (atomic_exchange(&g_sample_logged, 1) == 0) {
        /* dump first up to 32 bytes of out (CT or CMAC) for sanity */
        int n = (int)(out_len < 32 ? out_len : 32);
        fprintf(stderr, "PER_CALL sample (mode=%s, %lu bytes): ", g_mode, out_len);
        for (int i = 0; i < n; i++) fprintf(stderr, "%02x", out[i]);
        if ((CK_ULONG)n < out_len) fprintf(stderr, "...");
        fprintf(stderr, "\n");
    }
    return 0;
}

static void *worker(void *arg) {
    sample_buf *sb = (sample_buf *)arg;
    sb->samples = malloc(sizeof(long) * SAMPLE_CAP);
    sb->n = 0;

    CK_SESSION_HANDLE sess;
    CK_RV rv = f_C_OpenSession(g_slot, CKF_SERIAL_SESSION | CKF_RW_SESSION, NULL, NULL, &sess);
    if (rv != CKR_OK) { fprintf(stderr, "worker OpenSession rv=0x%lx\n", rv); return NULL; }

    /* Per-worker pre-allocated buffers. Output buffer cap chosen to fit GCM
     * tag (+16) for the largest payload we exercise (1024). */
    CK_BYTE payload[2048];
    CK_BYTE out[2048 + 32];
    if (getrandom(payload, (size_t)g_payload, 0) != g_payload) {
        fprintf(stderr, "worker getrandom payload failed\n");
        f_C_CloseSession(sess);
        return NULL;
    }

    while (!g_stop) {
        long t0 = now_ns();
        int rc = do_tx(sess, payload, (CK_ULONG)g_payload, out, sizeof(out));
        if (rc != 0) {
            atomic_fetch_add(&g_errs, 1);
            otel_record_err(g_otel);
            /* keep looping; cluster typically recovers in <60s. Logging once
             * per worker to avoid log floods on full-cell failures. */
            static __thread int logged = 0;
            if (!logged) {
                fprintf(stderr, "worker tx error rc=0x%x mode=%s — continuing\n", rc, g_mode);
                logged = 1;
            }
            continue;
        }
        long t1 = now_ns();
        long dur = t1 - t0;
        if (sb->n < SAMPLE_CAP) sb->samples[sb->n++] = dur;
        atomic_fetch_add(&g_ops, 1);
        otel_record_op(g_otel, dur);
    }

    f_C_CloseSession(sess);
    return NULL;
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--threads") && i+1 < argc) g_threads = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--seconds") && i+1 < argc) g_seconds = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--algo") && i+1 < argc) g_algo = argv[++i];
        else if (!strcmp(argv[i], "--mode") && i+1 < argc) g_mode = argv[++i];
        else if (!strcmp(argv[i], "--payload") && i+1 < argc) g_payload = atoi(argv[++i]);
        /* U-CH-5: telemetry labels — wrapper passes these through. */
        else if (!strcmp(argv[i], "--run-id") && i+1 < argc) g_run_id = argv[++i];
        else if (!strcmp(argv[i], "--unit-id") && i+1 < argc) g_unit_id = argv[++i];
        else if (!strcmp(argv[i], "--process-idx") && i+1 < argc) g_process_idx = argv[++i];
        else if (!strcmp(argv[i], "--cluster-size") && i+1 < argc) g_cluster_size = atoi(argv[++i]);
        else { fprintf(stderr,
            "Usage: %s [--threads N] [--seconds S] [--algo aes_128|aes_256] "
            "[--mode ecb|cbc|ctr|gcm|cmac] [--payload 256|1024] "
            "[--run-id RID] [--unit-id UID] [--process-idx I] [--cluster-size N]\n",
            argv[0]);
            return 2; }
    }

    if (!strcmp(g_algo, "aes_128")) { g_keybits = 128; g_kek_label = "BMT_KEK_AES128"; }
    else if (!strcmp(g_algo, "aes_256")) { g_keybits = 256; g_kek_label = "BMT_KEK_AES256"; }
    else { fprintf(stderr, "--algo must be aes_128 or aes_256\n"); return 2; }

    if      (!strcmp(g_mode, "ecb"))  g_mode_e = M_ECB;
    else if (!strcmp(g_mode, "cbc"))  g_mode_e = M_CBC;
    else if (!strcmp(g_mode, "ctr"))  g_mode_e = M_CTR;
    else if (!strcmp(g_mode, "gcm"))  g_mode_e = M_GCM;
    else if (!strcmp(g_mode, "cmac")) g_mode_e = M_CMAC;
    else { fprintf(stderr, "--mode must be one of ecb|cbc|ctr|gcm|cmac\n"); return 2; }

    if (g_payload <= 0 || g_payload > 2048) {
        fprintf(stderr, "--payload must be in (0, 2048]\n"); return 2;
    }

    fprintf(stderr, "config: threads=%d seconds=%d algo=%s keybits=%d mode=%s payload=%d kek=%s\n",
            g_threads, g_seconds, g_algo, g_keybits, g_mode, g_payload, g_kek_label);

    void *lib = dlopen("/opt/cloudhsm/lib/libcloudhsm_pkcs11.so", RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }

    #define BIND(sym) f_##sym = (p##sym)dlsym(lib, #sym); if (!f_##sym) { fprintf(stderr, "dlsym %s\n", #sym); return 1; }
    BIND(C_Initialize)
    BIND(C_GetSlotList)
    BIND(C_OpenSession)
    BIND(C_CloseSession)
    BIND(C_Login)
    BIND(C_FindObjectsInit)
    BIND(C_FindObjects)
    BIND(C_FindObjectsFinal)
    BIND(C_EncryptInit)
    BIND(C_Encrypt)
    BIND(C_SignInit)
    BIND(C_Sign)
    #undef BIND

    CK_RV rv = f_C_Initialize(NULL);
    if (rv != CKR_OK) { fprintf(stderr, "C_Initialize rv=0x%lx\n", rv); return 1; }

    CK_ULONG nslot = 0;
    f_C_GetSlotList(1, NULL, &nslot);
    if (nslot == 0) { fprintf(stderr, "no slots\n"); return 1; }
    CK_SLOT_ID *slots = calloc(nslot, sizeof(CK_SLOT_ID));
    f_C_GetSlotList(1, slots, &nslot);
    g_slot = slots[0];
    fprintf(stderr, "slot=0x%lx\n", g_slot);

    /* Setup session: login + KEK lookup. Kept open until process exit so
     * the SDK 5 client doesn't tear down its connection pool while worker
     * threads are mid-OpenSession (same workaround as v3_bench.c). */
    static CK_SESSION_HANDLE setup;
    rv = f_C_OpenSession(g_slot, CKF_SERIAL_SESSION | CKF_RW_SESSION, NULL, NULL, &setup);
    if (rv != CKR_OK) { fprintf(stderr, "setup OpenSession rv=0x%lx\n", rv); return 1; }
    char *pin = getenv("CLOUDHSM_PIN");
    if (!pin) { fprintf(stderr, "set CLOUDHSM_PIN env\n"); return 1; }
    rv = f_C_Login(setup, CKU_USER, (CK_UTF8CHAR_PTR)pin, (CK_ULONG)strlen(pin));
    if (rv != CKR_OK && rv != CKR_USER_ALREADY_LOGGED_IN) {
        fprintf(stderr, "C_Login rv=0x%lx\n", rv); return 1;
    }

    /* KEK lookup by label — handle is cluster-wide for token-resident keys. */
    CK_OBJECT_CLASS oc = CKO_SECRET_KEY;
    CK_ATTRIBUTE find_tpl[] = {
        { CKA_CLASS, &oc, sizeof(oc) },
        { CKA_LABEL, (CK_VOID_PTR)g_kek_label, (CK_ULONG)strlen(g_kek_label) },
    };
    rv = f_C_FindObjectsInit(setup, find_tpl, 2);
    if (rv != CKR_OK) { fprintf(stderr, "KEK FindObjectsInit rv=0x%lx\n", rv); return 1; }
    CK_OBJECT_HANDLE found[4]; CK_ULONG nfound = 0;
    rv = f_C_FindObjects(setup, found, 4, &nfound);
    f_C_FindObjectsFinal(setup);
    if (rv != CKR_OK || nfound < 1) {
        fprintf(stderr, "KEK '%s' not found rv=0x%lx n=%lu — provision via cloudhsm-cli\n",
                g_kek_label, rv, nfound);
        return 1;
    }
    g_kek = found[0];
    fprintf(stderr, "KEK %s handle=0x%lx\n", g_kek_label, g_kek);

    pthread_t *threads = calloc(g_threads, sizeof(pthread_t));
    sample_buf *sbs = calloc(g_threads, sizeof(sample_buf));

    /* U-CH-5: OTel emitter — only when run-id supplied (so unit tests / smoke
     * runs without telemetry side effects keep working). Best-effort: NULL ctx
     * means record_op is a no-op. */
    if (g_run_id && *g_run_id) {
        char algo_upper[16]; size_t na = strlen(g_algo);
        for (size_t i = 0; i < na && i + 1 < sizeof algo_upper; i++)
            algo_upper[i] = (char)((g_algo[i] >= 'a' && g_algo[i] <= 'z') ? g_algo[i] - 32 : g_algo[i]);
        algo_upper[na < sizeof algo_upper ? na : sizeof algo_upper - 1] = '\0';
        char mode_upper[16]; size_t nm = strlen(g_mode);
        for (size_t i = 0; i < nm && i + 1 < sizeof mode_upper; i++)
            mode_upper[i] = (char)((g_mode[i] >= 'a' && g_mode[i] <= 'z') ? g_mode[i] - 32 : g_mode[i]);
        mode_upper[nm < sizeof mode_upper ? nm : sizeof mode_upper - 1] = '\0';
        g_otel = otel_init(g_run_id, g_process_idx, g_unit_id, "PER_CALL_RAW",
                           algo_upper, mode_upper, g_payload, g_cluster_size, "NA");
    }

    long start_ns = now_ns();
    for (int i = 0; i < g_threads; i++)
        pthread_create(&threads[i], NULL, worker, &sbs[i]);

    sleep(g_seconds);
    g_stop = 1;
    for (int i = 0; i < g_threads; i++) pthread_join(threads[i], NULL);
    long end_ns = now_ns();
    otel_close(g_otel); g_otel = NULL;

    long total = atomic_load(&g_ops);
    long errs = atomic_load(&g_errs);
    double sec = (end_ns - start_ns) / 1e9;
    double ops_s = total / sec;

    long n_samples = 0;
    for (int i = 0; i < g_threads; i++) n_samples += sbs[i].n;
    long *all = malloc(sizeof(long) * (n_samples + 1));
    long off = 0;
    for (int i = 0; i < g_threads; i++) {
        memcpy(all + off, sbs[i].samples, sizeof(long) * sbs[i].n);
        off += sbs[i].n;
    }
    qsort(all, n_samples, sizeof(long), cmp_long);
    double p50 = n_samples ? all[n_samples / 2] / 1e6 : 0;
    double p95 = n_samples ? all[(long)(n_samples * 0.95)] / 1e6 : 0;
    double p99 = n_samples ? all[(long)(n_samples * 0.99)] / 1e6 : 0;

    printf("=== PER_CALL native PKCS#11 bench (algo=%s mode=%s payload=%d) ===\n",
           g_algo, g_mode, g_payload);
    printf("threads=%d seconds=%.2f tx=%ld errs=%ld\n",
           g_threads, sec, total, errs);
    printf("tx_per_sec=%.1f\n", ops_s);
    printf("p50_ms=%.2f p95_ms=%.2f p99_ms=%.2f (n=%ld)\n", p50, p95, p99, n_samples);
    return 0;
}
