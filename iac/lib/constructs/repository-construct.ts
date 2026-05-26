import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface RepositoryConstructProps {
  /** "codecommit" | "github" - selected via cdk.json context `repositoryProvider`. */
  readonly provider: 'codecommit' | 'github';
  readonly operatorRole?: iam.IRole;
}

/**
 * Per C-9: AWS CodeCommit was deprecated for new accounts in mid-2024.
 * If `provider === "github"`, no CodeCommit resource is created; instead an SSM
 * parameter records a manual handoff README. Operator runs a separate GitHub
 * repository handoff script.
 */
export class RepositoryConstruct extends Construct {
  public readonly codecommitRepository?: codecommit.IRepository;
  public readonly handoffParameter?: ssm.IParameter;

  constructor(scope: Construct, id: string, props: RepositoryConstructProps) {
    super(scope, id);

    if (props.provider === 'codecommit') {
      const repo = new codecommit.Repository(this, 'Repo', {
        repositoryName: 'hsm-bmt',
        description: 'CloudHSM CloudHSM BMT Phase 1 - IaC, loader, observability, web console',
      });
      this.codecommitRepository = repo;
      if (props.operatorRole) {
        repo.grantPullPush(props.operatorRole);
      }
    } else {
      this.handoffParameter = new ssm.StringParameter(this, 'GithubHandoff', {
        parameterName: '/hsm-bmt/core/repo-instructions',
        stringValue: [
          'CodeCommit unavailable for this account (C-9).',
          'Repository hosted on GitHub (private). Run scripts/handoff-github.sh',
          'with $SDS_GITHUB_USERS env var set to whitespace-separated GitHub handles.',
          'Handoff invites collaborators via the GitHub REST API.',
        ].join('\n'),
        description: 'Repository handoff instructions for GitHub fallback',
      });
    }
  }
}
