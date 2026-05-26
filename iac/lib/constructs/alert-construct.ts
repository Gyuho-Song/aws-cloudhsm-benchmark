import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface AlertConstructProps {
  readonly envSuffix: string;
  /**
   * Operator email addresses to subscribe to the alert topic. When omitted, the topic
   * is created without subscriptions (operator adds them later via console).
   */
  readonly operatorEmails?: string[];
}

/**
 * Creates the SNS topic for AMP Alert Manager → operator routing. Subscribes the
 * provided operator emails (each subscriber receives a confirmation email and must
 * click the link before notifications start).
 */
export class AlertConstruct extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertConstructProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Topic', {
      topicName: `hsm-bmt-alerts-${props.envSuffix}`,
      displayName: 'CloudHSM BMT alerts',
    });

    for (const email of props.operatorEmails ?? []) {
      this.topic.addSubscription(new subs.EmailSubscription(email));
    }
  }
}
