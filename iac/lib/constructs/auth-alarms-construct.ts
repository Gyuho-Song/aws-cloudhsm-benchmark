import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface AuthAlarmsConstructProps {
  readonly preTokenGenFn: lambda.IFunction;
  readonly authorizerFn: lambda.IFunction;
  readonly sessionsTable: dynamodb.ITable;
  /** ARN of the existing observability SNS topic (`hsm-bmt-alerts-{env}`).
   *  Read from SSM `/hsm-bmt/observability/alert-sns-topic-arn`. */
  readonly alertTopicArn: string;
}

/**
 * U-CH-1 alarms (NFR-CH-8.1..8.4 + brownfield SNS reuse).
 *
 *   A1 — PreTokenGen errors P1 (≥1/5min)            NFR-CH-8.1
 *   A2 — PreTokenGen errors P2 early-warn (3/15min) NFR-CH-8.1
 *   A3 — Authorizer errors (≥5/5min)                NFR-CH-8.2
 *   A4 — Authorizer p99 latency > 1000ms            NFR-CH-8.3
 *   A5 — DDB ThrottledRequests (Get/Put) ≥ 1/5min   NFR-CH-8.4
 */
export class AuthAlarmsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AuthAlarmsConstructProps) {
    super(scope, id);

    const topic = sns.Topic.fromTopicArn(this, 'AlertTopic', props.alertTopicArn);
    const action = new cwActions.SnsAction(topic);

    // A1 — NFR-CH-8.1: ≥1 in 5 min. admin 1 명 환경, baseline 0 errors → 1 회만으로 즉시 alarm.
    props.preTokenGenFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'A1PreTokenGenErrorsP1', {
        alarmName: 'hsm-bmt-pretokengen-errors-p1',
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(action);

    // A2 (early-warn)
    props.preTokenGenFn.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' })
      .createAlarm(this, 'A2PreTokenGenErrorsP2', {
        alarmName: 'hsm-bmt-pretokengen-errors-p2',
        threshold: 3,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(action);

    // A3 — NFR-CH-8.2: ≥5 in 5 min.
    props.authorizerFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'A3AuthorizerErrors', {
        alarmName: 'hsm-bmt-authorizer-errors',
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(action);

    // A4 — p99 latency
    props.authorizerFn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' })
      .createAlarm(this, 'A4AuthorizerLatencyP99', {
        alarmName: 'hsm-bmt-authorizer-latency-p99',
        threshold: 1000,
        evaluationPeriods: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        // invoke 0 시간대는 metric missing — alarm 무시 (cold-start staged rollout 용도)
        treatMissingData: cw.TreatMissingData.MISSING,
      })
      .addAlarmAction(action);

    // A5 — DDB throttle (NOT UserErrors). Wrap IMetric → Alarm via cw.Alarm
    // because metricThrottledRequestsForOperations returns IMetric (no fluent
    // createAlarm helper).
    const throttleMetric = (props.sessionsTable as dynamodb.Table)
      .metricThrottledRequestsForOperations({
        operations: [dynamodb.Operation.GET_ITEM, dynamodb.Operation.PUT_ITEM],
        period: cdk.Duration.minutes(5),
      });
    const a5 = new cw.Alarm(this, 'A5DdbThrottle', {
      alarmName: 'hsm-bmt-admin-sessions-throttle',
      metric: throttleMetric,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    a5.addAlarmAction(action);
  }
}
