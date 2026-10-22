# Stream Panel workflow

- Preserve data, collection, profile isolation and rollback checkpoints during UI work.
- Complete local review, appropriate tests and responsive checks before handing a PR to CI.
- User preference: check CI and deployment manually in the active conversation. Do not
  create background monitors, scheduled checks or automations for CI or deployments.
- Check the repository, PR number and reviewed head SHA. Merge only after the exact
  head's Quality gate succeeds; stop on failures, conflicts or unexpected commits.
- After merging to dev, create the scoped dev-to-main release PR, check its exact source
  tree and successful CI, then merge. Existing production deployment runs only after main CI.
- Confirm deployment and release health manually before reporting completion.
