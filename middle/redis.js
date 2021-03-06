const config = require('../config')
const debug = require('debug')('READR-API:middle:redis')
const isProd = process.env.NODE_ENV === 'production'
const RedisConnectionPool = require('redis-connection-pool')
const { get, } = require('lodash')

const redisPoolRead = RedisConnectionPool('myRedisPoolRead', {
  host: config.REDIS_READ_HOST || '127.0.0.1',
  port: config.REDIS_READ_PORT || '6379',
  max_clients: config.REDIS_MAX_CLIENT || 50,
  perform_checks: false,
  database: 0,
  options: {
    auth_pass: config.REDIS_AUTH || '',
  },
})

const redisPoolWrite = isProd ? RedisConnectionPool('myRedisPoolWrite', {
  host: config.REDIS_WRITE_HOST || '127.0.0.1',
  port: config.REDIS_WRITE_PORT || '6379',
  max_clients: config.REDIS_MAX_CLIENT || 50,
  perform_checks: false,
  database: 0,
  options: {
    auth_pass: config.REDIS_AUTH || '',
  },
}) : redisPoolRead

class TimeoutHandler {
  constructor (callback) {
    this.isResponded = false
    this.timeout = config.REDIS_CONNECTION_TIMEOUT || 2000

    this.destroy = this.destroy.bind(this)
    this.init = this.init.bind(this)
    this.init(callback)
  }
  init (callback) {
    this.timeoutHandler = setInterval(() => {
      this.timeout -= 1000
      debug('Redis counting down...', this.timeout)
      if (this.isResponded) {
        this.destroy()
        debug('this.timeoutHandler destroying...')
        return
      }
      if (this.timeout <= 0) {
        this.destroy()
        debug('ERROR: Timeout occured while connecting to redis.')
        callback && callback({ error: 'ERROR: Timeout occured while connecting to redis.', data: null, })
      }
    }, 1000)
  }
  destroy () {
    debug('TimeoutHandler is about to destroy...')
    clearInterval(this.timeoutHandler)
  }
}

const redisFetching = (key, callback) => {
  debug('Fetching data from redis.')
  debug(decodeURIComponent(key))
  const timeoutHandler = new TimeoutHandler(callback)
  const onFinished = (error, data) => {
    timeoutHandler.isResponded = true
    timeoutHandler.destroy()
    console.info('REDIS### FETCHING RESULT FOR "', key.substring(0, 80), '..."\nREDIS### DATA LENGTH:', get(data, 'length'), '\nREDIS### ANY ERROR?', error || false)
    if (timeoutHandler.timeout <= 0) {return }
    callback && callback({ error, data, })
  }
  redisPoolRead.get(decodeURIComponent(key), (error, data) => {
    if (!error) {
      redisPoolRead.ttl(decodeURIComponent(key), (err, dt) => {
        if (!err && dt) {
          debug('Ttl:', dt)
          if (dt === -1) {
            redisPoolWrite.del(decodeURIComponent(key), (e) => {
              if (e) {
                console.error('REDIS: deleting key ', decodeURIComponent(key), 'from redis in fail ', e)
              }
              console.error('REDIS: deleting key ', decodeURIComponent(key), 'from redis in fail ', e)
              onFinished(e, data)
            })
          } else {
            onFinished(err, data)
          }
        } else {
          console.error('REDIS: fetching ttl in fail ', err)
          onFinished(err, data)
        }
      })
    } else {
      console.error('REDIS: fetching key/data in fail ', error)
      onFinished(error, data)
    }
  })
}
const redisWriting = (key, data, callback, timeout) => {
  debug('Setting key/data to redis. Timeout:', timeout || config.REDIS_TIMEOUT || 5000)
  debug(decodeURIComponent(key))
  const timeoutHandler = new TimeoutHandler(callback)
  redisPoolWrite.set(decodeURIComponent(key), data, (err) => {
    if(err) {
      console.error('redis writing in fail. ', decodeURIComponent(key), err)
    } else {
      redisPoolWrite.expire(decodeURIComponent(key), timeout || config.REDIS_TIMEOUT || 5000, function(error) {
        console.info('REDIS### DONE FOR WRITING "', key.substring(0, 80), '..."\nREDIS### ANY ERROR?', error || false)
        if(error) {
          console.error('failed to set redis expire time. ', decodeURIComponent(key), err)
        } else {
          debug('Wrote redis successfully.')
          timeoutHandler.isResponded = true
          timeoutHandler.destroy()
          callback && callback()
        }
      })
    }
  })
}

const redisFetchCmd = (cmd, key, field, callback) => {
  const timeoutHandler = new TimeoutHandler(callback)
  const onFinished = (error, data) => {
    timeoutHandler.isResponded = true
    timeoutHandler.destroy()
    console.info('REDIS### FETCHING RESULT FOR', cmd, key, field, '\nREDIS### DATA LENGTH:', get(data, 'length'), '\nREDIS### ANY ERROR?', error || false)
    if (timeoutHandler.timeout <= 0) { return }
    callback && callback({ error, data, })
  }
  redisPoolRead.send_command(cmd, [ key, ...field, ], function (err, data) {
    onFinished(err, data)
  })
}
const redisWriteCmd = (cmd, key, value, callback) => {
  const timeoutHandler = new TimeoutHandler(callback)
  const onFinished = (error, data) => {
    timeoutHandler.isResponded = true
    timeoutHandler.destroy()
    console.info('REDIS### DONE FOR WRITING', cmd, key, '\nREDIS### ANY ERROR?', error || false)
    if (timeoutHandler.timeout <= 0) { return }
    callback && callback({ error, data, })
  }
  redisPoolWrite.send_command(cmd, [ key, ...value, ], function (err, data) {
    onFinished(err, data)
  })
}

const insertIntoRedis = (req, res) => {
  redisWriting(req.url, res.dataString, () => {
    // next()
  })
}
const fetchFromRedis = (req, res, next) => {
  redisFetching(req.url, ({ error, data, }) => {
    if (!error) {
      res.redis = data
      next()
    } else {
      next(error)
    }
  })
}
const fetchFromRedisCmd = (req, res, next) => {
  const cmd = req.redis_get.cmd
  const key = req.redis_get.key
  const field = req.redis_get.field || []
  debug(`Goin to get(${cmd}) data from redis.`, key, field)
  redisFetchCmd(cmd, key, field, ({ error, data, }) => {
    if (!error) {
      res.redis = data
      next()
    } else {
      console.error(`Error occurred during fetching(${cmd}) data from redis.`)
      console.error(error)
      next(error)
    }
  })
}
const insertIntoRedisSadd = (req) => {
  const key = req.sadd.key
  const value = req.sadd.value
  debug('Abt to SADD data to redis.', key, value)
  redisWriteCmd('SADD', key, value, ({ error, }) => {
    if (!error) {
      // next()
    } else {
      // next(error)
    }    
  })
}

module.exports = {
  fetchFromRedis,
  fetchFromRedisCmd,
  insertIntoRedis,
  insertIntoRedisSadd,
  redisFetchCmd,
  redisFetching,
  redisWriting,
  redisWriteCmd,
}
