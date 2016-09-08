'use strict'

const debug = require('debug')('skiff.node')
const merge = require('deepmerge')
const Multiaddr = require('multiaddr')
const EventEmitter = require('events')
const async = require('async')

const PassiveNetwork = require('./network/passive')
const ActiveNetwork = require('./network/active')
const IncomingDispatcher = require('./incoming-dispatcher')
const State = require('./state')
const CommandQueue = require('./command-queue')
const Commands = require('./commands')
const DB = require('./db')
const Leveldown = require('./leveldown')
const Iterator = require('./iterator')

const defaultOptions = {
  server: {},
  rpcTimeoutMS: 5000,
  peers: []
}

class Node extends EventEmitter {

  constructor (id, _options) {
    debug('creating node %s with options %j', id, _options)
    super()
    this.id = id
    this._options = merge(defaultOptions, _options || {})

    this._db = new DB(this.id, this._options.db)

    this._dispatcher = new IncomingDispatcher({id})

    this._state = new State(this.id, this._dispatcher, this._db, this._options)
    this._state.on('warning', warn => this.emit('warning', warn))

    this._commandQueue = new CommandQueue()
    this._commands = new Commands(this.id, this._commandQueue, this._state)

    this._startState = 'stopped'
  }

  start (cb) {
    debug('%s: start state is %s', this.id, this._startState)
    if (this._startState === 'stopped') {
      this._startState = 'starting'
      debug('starting node %s', this.id)
      async.parallel(
        [
          this._startNetwork.bind(this),
          this._loadPersistedState.bind(this)
        ],
        err => {
          debug('%s: done starting', this.id)
          if (err) {
            this._startState = 'stopped'
          } else {
            this._startState = 'started'
            this.emit('started')
          }
          cb(err)
        })
    } else if (this._startState === 'started') {
      process.nextTick(cb)
    } else if (this._startState === 'starting') {
      this.once('started', cb)
    }
  }

  _startNetwork (cb) {
    const address = Multiaddr(this.id).nodeAddress()
    const passiveNetworkOptions = {
      server: merge(
        {
          port: address.port,
          host: address.address
        },
        this._options.server)
    }
    debug('about to configure passive network for %s with options %j', this.id, passiveNetworkOptions)
    const passiveNetwork = new PassiveNetwork(passiveNetworkOptions)

    if (cb) {
      passiveNetwork.once('listening', () => cb()) // do not carry event args into callback
    }

    this._network = {
      passive: passiveNetwork,
      active: new ActiveNetwork()
    }

    this._network.passive.pipe(this._dispatcher, { end: false })
    this._network.active.pipe(this._dispatcher, { end: false })

    this._state.passive.pipe(this._network.passive, { end: false })
    this._state.active.pipe(this._network.active, { end: false })
  }

  _loadPersistedState (cb) {
    this._db.load((err, results) => {
      if (err) {
        cb(err)
      } else {
        this._state._log.setEntries(results.log)
        if (results.meta.currentTerm) {
          this._state._setTerm(results.meta.currentTerm)
        }
        if (results.meta.votedFor) {
          this._state._setVotedFor(results.meta.votedFor)
        }
        if (results.meta.peers) {
          this._state._peers = results.meta.peers
        }
        cb()
      }
    })
  }

  stop (cb) {
    if (this._network) {
      if (cb) {
        this._network.passive.once('closed', cb)
      }
      this._network.passive.end()
      this._network.active.end()
    } else if (cb) {
      process.nextTick(cb)
    }

    this._state.stop()

    delete this._network
  }

  join (address, done) {
    debug('%s: joining %s', this.id, address)
    this.start(err => {
      if (err) {
        done(err)
      } else {
        this._state.join(address, done)
      }
    })
  }

  leave (address, done) {
    debug('%s: leaving %s', this.id, address)
    this.start(err => {
      if (err) {
        done(err)
      } else {
        this._state.leave(address, done)
      }
    })
  }

  command (command, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    this._commandQueue.write({command, options, callback})
  }

  is (state) {
    const currentState = this._state._stateName
    debug('%s: current state is %s', this.id, currentState)
    return this._state._stateName === state
  }

  leveldown () {
    return new Leveldown(this)
  }

  iterator (options) {
    return new Iterator(this._db.state, options)
  }
}

module.exports = Node
