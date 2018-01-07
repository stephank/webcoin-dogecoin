#!/usr/bin/env node

const test = require('tape')
const testsuite = require('webcoin-param-tests')
const dogecoin = require('.')

// By default, run only blockchain tests.
// The full test suite requires network connectivity.
if (process.env.TEST_ALL) {
  testsuite(dogecoin, test)
} else {
  testsuite.blockchain(dogecoin, test)
}
