#!/usr/bin/env node

require('@zyno-io/ts-server-foundation/otel').init();

const { app } = require('./app');

app.run();
