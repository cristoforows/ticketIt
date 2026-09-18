# tracer-fake-clock

M1.3 tracer package. Proves the experiments workspace works end to end:
fresh clone, `npm ci`, `npm test`, and a matching recorded evidence file.
It has no bearing on any real integration; it only exercises
`shared`'s `FakeClock` through a local `file:../shared` dependency.

## Run

```sh
cd experiments/tracer-fake-clock
npm ci
npm test
```

Evidence: [docs/evidence/m1/14-experiment-workspace.md](../../docs/evidence/m1/14-experiment-workspace.md).
