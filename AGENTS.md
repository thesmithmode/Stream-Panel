# Stream Panel workflow

- Preserve data, collection, profile isolation and rollback checkpoints during UI work.
- Complete local review, appropriate tests and responsive checks before handing a PR to CI.
- For changes the user has authorized for release, use a background CI/deployment monitor.
  Do not spend interactive turns polling, sleeping for CI, or waiting for deployment.
- Bind each monitor to the repository, PR number and reviewed head SHA. Merge only after
  the exact head's Quality gate succeeds; stop on failures, conflicts or unexpected commits.
- After merging to dev, create the scoped dev-to-main release PR, check its exact source
  tree and successful CI, then merge. Existing production deployment runs only after main CI.
- Confirm the deployment result and release health in the background. Notify the user once
  on completion or actionable failure, then disable the completed monitor.
