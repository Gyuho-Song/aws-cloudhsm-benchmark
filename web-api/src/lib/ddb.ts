import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let _ddb: DynamoDBDocumentClient | undefined;

export const ddb = (): DynamoDBDocumentClient => {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _ddb;
};
