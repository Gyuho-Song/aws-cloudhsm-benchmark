import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

import { json } from './lib/types';

const ssm = new SSMClient({});

/**
 * Returns the latest published loader binary verification metadata so the
 * web console can prefill the run-authoring form. The build script
 * (build-loader.sh on the loader EC2) writes both keys to SSM whenever a
 * new loader.jar is uploaded.
 */
export async function handler(_event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const out = await ssm.send(new GetParametersCommand({
    Names: ['/hsm-bmt/loader/version-id', '/hsm-bmt/loader/sha256'],
  }));
  const map = new Map((out.Parameters ?? []).map((p) => [p.Name, p.Value]));
  return json(200, {
    versionId: map.get('/hsm-bmt/loader/version-id') ?? null,
    sha256: map.get('/hsm-bmt/loader/sha256') ?? null,
  });
}
