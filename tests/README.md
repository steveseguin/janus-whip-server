# Regression tests

Run the dependency-free route/transport regressions with Node.js 18 or newer:

```
node --test tests/trickle.test.js
```

The tests execute the full server source and Janus transport module. Startup,
Express route registration, logging and the WebSocket boundary use inert test
collaborators; no server or network connection is started. Synthetic Janus
responses cover ordinary trickling, delayed/successful/rejected ICE restarts,
completion markers, empty fragments, authorization, and transport queueing.
These tests do not validate real Janus, ICE connectivity or media delivery.
