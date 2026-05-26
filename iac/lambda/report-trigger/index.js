"use strict";
/**
 * DynamoDB Streams trigger that fires the Korean report renderer on the loader
 * EC2 whenever a row in `bmt-runs` flips its status to COMPLETED.
 *
 * The renderer itself is a Python package (`report/`) running on the loader
 * (it already has S3 / AMP read access via the instance role). This lambda
 * issues an SSM SendCommand to invoke `/usr/local/bin/render-report.sh <runId>`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const client_ssm_1 = require("@aws-sdk/client-ssm");
const ssm = new client_ssm_1.SSMClient({});
const LOADER_INSTANCE_ID = process.env.LOADER_INSTANCE_ID;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET;
async function handler(event) {
    for (const rec of event.Records) {
        if (rec.eventName !== 'MODIFY' && rec.eventName !== 'INSERT')
            continue;
        const img = rec.dynamodb?.NewImage;
        if (!img)
            continue;
        const status = img.status?.S;
        const runId = img.runId?.S;
        if (status !== 'COMPLETED' || !runId)
            continue;
        console.log(`render report for ${runId}`);
        await ssm.send(new client_ssm_1.SendCommandCommand({
            InstanceIds: [LOADER_INSTANCE_ID],
            DocumentName: 'AWS-RunShellScript',
            Parameters: {
                commands: [
                    `RUN_ID=${runId} S3_BUCKET=${RESULTS_BUCKET} /usr/local/bin/render-report.sh`,
                ],
            },
            Comment: `Render Korean report for ${runId}`,
        }));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7R0FPRzs7QUFTSCwwQkFxQkM7QUEzQkQsb0RBQW9FO0FBRXBFLE1BQU0sR0FBRyxHQUFHLElBQUksc0JBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUM5QixNQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQW1CLENBQUM7QUFDM0QsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFFNUMsS0FBSyxVQUFVLE9BQU8sQ0FBQyxLQUEwQjtJQUN0RCxLQUFLLE1BQU0sR0FBRyxJQUFJLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNoQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxTQUFTLEtBQUssUUFBUTtZQUFFLFNBQVM7UUFDdkUsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUM7UUFDbkMsSUFBSSxDQUFDLEdBQUc7WUFBRSxTQUFTO1FBQ25CLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQzdCLE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBQzNCLElBQUksTUFBTSxLQUFLLFdBQVcsSUFBSSxDQUFDLEtBQUs7WUFBRSxTQUFTO1FBRS9DLE9BQU8sQ0FBQyxHQUFHLENBQUMscUJBQXFCLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDMUMsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksK0JBQWtCLENBQUM7WUFDcEMsV0FBVyxFQUFFLENBQUMsa0JBQWtCLENBQUM7WUFDakMsWUFBWSxFQUFFLG9CQUFvQjtZQUNsQyxVQUFVLEVBQUU7Z0JBQ1YsUUFBUSxFQUFFO29CQUNSLFVBQVUsS0FBSyxjQUFjLGNBQWMsa0NBQWtDO2lCQUM5RTthQUNGO1lBQ0QsT0FBTyxFQUFFLDRCQUE0QixLQUFLLEVBQUU7U0FDN0MsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRHluYW1vREIgU3RyZWFtcyB0cmlnZ2VyIHRoYXQgZmlyZXMgdGhlIEtvcmVhbiByZXBvcnQgcmVuZGVyZXIgb24gdGhlIGxvYWRlclxuICogRUMyIHdoZW5ldmVyIGEgcm93IGluIGBibXQtcnVuc2AgZmxpcHMgaXRzIHN0YXR1cyB0byBDT01QTEVURUQuXG4gKlxuICogVGhlIHJlbmRlcmVyIGl0c2VsZiBpcyBhIFB5dGhvbiBwYWNrYWdlIChgcmVwb3J0L2ApIHJ1bm5pbmcgb24gdGhlIGxvYWRlclxuICogKGl0IGFscmVhZHkgaGFzIFMzIC8gQU1QIHJlYWQgYWNjZXNzIHZpYSB0aGUgaW5zdGFuY2Ugcm9sZSkuIFRoaXMgbGFtYmRhXG4gKiBpc3N1ZXMgYW4gU1NNIFNlbmRDb21tYW5kIHRvIGludm9rZSBgL3Vzci9sb2NhbC9iaW4vcmVuZGVyLXJlcG9ydC5zaCA8cnVuSWQ+YC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IER5bmFtb0RCU3RyZWFtRXZlbnQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IFNTTUNsaWVudCwgU2VuZENvbW1hbmRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNzbSc7XG5cbmNvbnN0IHNzbSA9IG5ldyBTU01DbGllbnQoe30pO1xuY29uc3QgTE9BREVSX0lOU1RBTkNFX0lEID0gcHJvY2Vzcy5lbnYuTE9BREVSX0lOU1RBTkNFX0lEITtcbmNvbnN0IFJFU1VMVFNfQlVDS0VUID0gcHJvY2Vzcy5lbnYuUkVTVUxUU19CVUNLRVQhO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogRHluYW1vREJTdHJlYW1FdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBmb3IgKGNvbnN0IHJlYyBvZiBldmVudC5SZWNvcmRzKSB7XG4gICAgaWYgKHJlYy5ldmVudE5hbWUgIT09ICdNT0RJRlknICYmIHJlYy5ldmVudE5hbWUgIT09ICdJTlNFUlQnKSBjb250aW51ZTtcbiAgICBjb25zdCBpbWcgPSByZWMuZHluYW1vZGI/Lk5ld0ltYWdlO1xuICAgIGlmICghaW1nKSBjb250aW51ZTtcbiAgICBjb25zdCBzdGF0dXMgPSBpbWcuc3RhdHVzPy5TO1xuICAgIGNvbnN0IHJ1bklkID0gaW1nLnJ1bklkPy5TO1xuICAgIGlmIChzdGF0dXMgIT09ICdDT01QTEVURUQnIHx8ICFydW5JZCkgY29udGludWU7XG5cbiAgICBjb25zb2xlLmxvZyhgcmVuZGVyIHJlcG9ydCBmb3IgJHtydW5JZH1gKTtcbiAgICBhd2FpdCBzc20uc2VuZChuZXcgU2VuZENvbW1hbmRDb21tYW5kKHtcbiAgICAgIEluc3RhbmNlSWRzOiBbTE9BREVSX0lOU1RBTkNFX0lEXSxcbiAgICAgIERvY3VtZW50TmFtZTogJ0FXUy1SdW5TaGVsbFNjcmlwdCcsXG4gICAgICBQYXJhbWV0ZXJzOiB7XG4gICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgYFJVTl9JRD0ke3J1bklkfSBTM19CVUNLRVQ9JHtSRVNVTFRTX0JVQ0tFVH0gL3Vzci9sb2NhbC9iaW4vcmVuZGVyLXJlcG9ydC5zaGAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAgQ29tbWVudDogYFJlbmRlciBLb3JlYW4gcmVwb3J0IGZvciAke3J1bklkfWAsXG4gICAgfSkpO1xuICB9XG59XG4iXX0=