const u = require('bitcoin-util')
const BN = require('bn.js')
const proto = require('bitcoin-protocol')
const DogeBlock = require('./block')

class Consensus {
  constructor (params) {
    Object.assign(this, params)
    this.interval = this.targetTimespan / this.targetSpacing
  }

  extend (params) {
    return new Consensus(Object.assign({}, this, params))
  }
}

// Pre-digishield
const plainConsensus = new Consensus({
  targetTimespan: 4 * 60 * 60,  // 4 hours
  targetSpacing: 60,  // 1 minute
  powLimit: new BN('00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16),
  digishield: false,
  auxPoW: false  // Actually unused right now
})

// Pre-auxPoW
const digishieldConsensus = plainConsensus.extend({
  targetTimespan: 60,  // 1 minute
  digishield: true
})

// Current
const auxPoWConsensus = digishieldConsensus.extend({
  auxPoW: true
})

// Get the consensus to use at the given height.
Consensus.get = (height) => {
  if (height < 145000) return plainConsensus
  if (height < 371337) return digishieldConsensus
  return auxPoWConsensus
}

// Calculate target based on the given consensus params, and previous block span.
const calculateTarget = (height, consensus, startBlock, endBlock) => {
  const targetTimespan = consensus.targetTimespan

  // Actual time taken to complete the interval
  const actualTimespan = endBlock.header.timestamp - startBlock.header.timestamp

  // Clamp timespan
  let timespan = actualTimespan
  let minTimespan, maxTimespan
  if (consensus.digishield) {
    // Amplitude filter
    timespan = targetTimespan + ((timespan - targetTimespan) / 8 | 0)
    minTimespan = targetTimespan - (targetTimespan / 4 | 0)
    maxTimespan = targetTimespan + (targetTimespan / 2 | 0)
  } else if (height > 10000) {
    minTimespan = targetTimespan / 4 | 0
    maxTimespan = targetTimespan * 4 | 0
  } else if (height > 5000) {
    minTimespan = targetTimespan / 8 | 0
    maxTimespan = targetTimespan * 4 | 0
  } else {
    minTimespan = targetTimespan / 16 | 0
    maxTimespan = targetTimespan * 4 | 0
  }
  timespan = Math.min(maxTimespan, timespan)
  timespan = Math.max(minTimespan, timespan)

  // Calculate target
  let target = new BN(u.expandTarget(endBlock.header.bits))
  target.imuln(timespan)
  target.idivn(targetTimespan)
  if (target.cmp(consensus.powLimit) === 1) {
    target = consensus.powLimit
  }
  return target.toBuffer('be', 32)
}

const params = {
  net: {
    magic: 0xc0c0c0c0,
    defaultPort: 22556,
    defaultWebPort: 25592,
    webSeeds: [],
    dnsSeeds: [
      'seed.multidoge.org',
      'seed2.multidoge.org',
      'seed.dogecoin.com',
      'seed.doger.dogecoin.com'
    ],
    staticPeers: [],
    messages: proto.messages.createStructs({
      header: DogeBlock.headerType
    })
  },

  blockchain: {
    shouldRetarget: (block, cb) => {
      const height = block.height
      const { interval } = Consensus.get(height)
      return cb(null, height % interval === 0)
    },

    calculateTarget: (block, chain, cb) => {
      const height = block.height
      const consensus = Consensus.get(height)
      chain.getBlock(block.header.prevHash, (err, endBlock) => {
        if (err) return cb(err)

        // Go back the full period unless it's the first retarget after genesis.
        // This fixes an issue where a 51% attack can change difficulty at will.
        let delta = consensus.interval
        if (height !== consensus.interval) delta += 1

        chain.getBlockAtHeight(height - delta, (err, startBlock) => {
          if (err) return cb(err)

          cb(null, calculateTarget(height, consensus, startBlock, endBlock))
        })
      })
    },

    miningHash: (header, cb) => {
      if (!(header instanceof DogeBlock)) {
        header = Object.assign(new DogeBlock(), header)
      }

      let hash
      try {
        hash = header.getMiningHash(header)
      } catch (err) {
        cb(err)
        return
      }
      cb(null, hash)
    },

    genesisHeader: {
      version: 1,
      prevHash: u.nullHash,
      merkleRoot: u.toHash('5b2a3f53f605d62c53e62932dac6925e3d74afa5a4b459745c36d42d0ed26a69'),
      timestamp: 1386325540,
      bits: 0x1e0ffff0,
      nonce: 99943
    },

    checkpoints: [
      {
        height: 371335,
        header: {
          version: 6422530,
          prevHash: u.toHash('462265b778f89534532f69dc06168dbe8b9e3e6b972de3e73ddbc960e895d2bf'),
          merkleRoot: u.toHash('d25b018e261dc189dcbf4fdfc180771135a25b0bd40ec90488a91990ac5d93cb'),
          timestamp: 1410464445,
          bits: 0x1b35312d,
          nonce: 3969999160
        }
      },
      {
        height: 371336,
        header: {
          version: 6422530,
          prevHash: u.toHash('8ad58fc406423207bdd82bed27c0c9a22f8241e3d3e8595191decb55a50b20c7'),
          merkleRoot: u.toHash('a0503bb44fd98e79239cc8f7b896a81b9a5fb1deb74e165173d7a530db34d877'),
          timestamp: 1410464569,
          bits: 0x1b2fdf75,
          nonce: 3401887720
        }
      }
      // FIXME: Encode an AuxPoW header here, somehow.
      // {
      //   height: 371337,
      //   header: {
      //     version: 6422786,
      //     prevHash: u.toHash('46a8b109fb016fa41abd17a19186ca78d39c60c020c71fcd2690320d47036f0d'),
      //     merkleRoot: u.toHash('ee27b8fb782a5bfb99c975f0d4686440b9af9e16846603e5f2830e0b6fbf158a'),
      //     timestamp: 1410464577,
      //     bits: 0x1b364184,
      //     nonce: 0
      //   }
      // }
    ]
  },

  wallet: require('bitcoinjs-lib').networks.dogecoin
}

params.blockchain.Block = params.net.Block = params.Block = DogeBlock

module.exports = params
