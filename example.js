#!/usr/bin/env node

const Node = require('webcoin')
const level = require('level')
const dogecoin = require('.')

const formatBlock = (block) => `${block.height}: ${block.header.getId()}`

const db = level('./chain.db')
const node = new Node(dogecoin, db)

node.peers.once('connect', () => {
  const tip = node.chain.getTip()
  console.log(`Connected, tip is ${formatBlock(tip)}`)

  node.chain.on('tip', (block) => {
    console.log(formatBlock(block))
  })
})

node.start()
