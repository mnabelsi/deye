# Notes for Claude

## Workflow
- When a change is finished and pushed, open a pull request to `master` and merge it yourself.
  Don't ask the owner whether to merge; they asked for every change to be merged.
- Before pushing, run `npm run check`. For changes to collection or the dashboard, try them against
  the mock DeyeCloud server (`npm run mock`, see README). For smart devices and automations, also run
  the mock eWeLink server (`npm run mock:ewelink`).
