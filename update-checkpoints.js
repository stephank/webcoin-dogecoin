#!/usr/bin/env node

const Node = require('webcoin')
const level = require('level')
const dogecoin = require('.')
const checkpoints = require('./checkpoints')

const checkpointInterval = 30000
const list = dogecoin.blockchain.checkpoints.slice(0)

const db = level('./chain.db')
const node = new Node(dogecoin, db)

const flush = (last) => {
  // Store the checkpoint and the block before it, because we need the extra
  // bit of history to resume consensus from this point.
  node.chain.store.get(last.header.prevHash, (err, prev) => {
    if (err) throw err
    list.push(prev, last)
    checkpoints.write(list)
    console.log(`Created checkpoint at height ${last.height}`)
  })
}

node.peers.once('connect', () => {
  console.log(`Connected, tip is at height ${node.chain.getTip().height}`)
  node.chain.on('tip', (block) => {
    if (block.height % checkpointInterval === 0) flush(block)
  })
})

node.on('synced', (tip) => {
  console.log(`Sync complete at height ${tip.height}`)
  process.exit(0)
})

node.start()
