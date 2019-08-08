/**
 * @module driver
 * Provides high-level helpers for DDP connection, method calls, subscriptions.
 */

import { EventEmitter } from 'events'
import * as settings from './settings'
import * as methodCache from './methodCache'
import { Message } from './message'
import { Socket } from './ddp'
import { logger, replaceLog } from './log'
import {
  ILogger,
  ISocketOptions,
  IRespondOptions,
  ICallback,
  IMessageCallback,
  ISubscriptionEvent,
  IMessage,
  IMessageMeta,
  IMessageReceipt,
  ISubscription,
  ICredentials,
  ILoginResult
} from '../interfaces'

/** Collection names */
const _messageCollectionName = 'stream-room-messages'
const _messageStreamName = '__my_messages__'

/** Compares message update timestamps */
export let lastReadTime: Date

/**
 * The integration property is applied as an ID on sent messages `bot.i` param
 * Should be replaced when connection is invoked by a package using the SDK
 * e.g. The Hubot adapter would pass its integration ID with credentials, like:
 */
export const integrationId = settings.integrationId

/**
 * Event Emitter for listening to connection (echoes selection of DDP events)
 * @example
 *  import { driver } from '@rocket.chat/sdk'
 *  driver.connect()
 *  driver.events.on('connected', () => console.log('driver connected'))
 */
export const events = new EventEmitter()

/**
 * An Websocket instance for interacting with Rocket.Chat.
 * Variable not initialised until `connect` called.
 */
export let ddp: Socket

/**
 * Websocket subscriptions, exported for direct polling by adapters
 * Variable not initialised until `prepMeteorSubscriptions` called.
 * @deprecated Use `ddp.Socket` instance subscriptions instead.
 */
export let subscriptions: { [id: string]: ISubscription } = {}

/** Save messages subscription to ensure only one created */
export let messages: ISubscription | undefined

/** Current user object populated from resolved login */
export let userId: string

/** Array of joined room IDs (for reactive queries) */
export let joinedIds: string[] = []

/** Allow override of default logging with adapter's log instance */
export function useLog (externalLog: ILogger) {
  replaceLog(externalLog)
}

/**
 * Initialise socket instance with given options or defaults.
 * Proxies the DDP module socket connection. Resolves with socket when open.
 * Accepts callback following error-first-pattern.
 * Error returned or promise rejected on timeout.
 * @example <caption>Use with callback</caption>
 *  import { driver } from '@rocket.chat/sdk'
 *  driver.connect({}, (err) => {
 *    if (err) throw err
 *    else console.log('connected')
 *  })
 * @example <caption>Using promise</caption>
 *  import { driver } from '@rocket.chat/sdk'
 *  driver.connect()
 *    .then(() => console.log('connected'))
 *    .catch((err) => console.error(err))
 */
export function connect (
  options: ISocketOptions | any = {},
  callback?: ICallback
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const config: ISocketOptions = Object.assign({}, settings, options) // override defaults
    config.host = config.host.replace(/(^\w+:|^)\/\//, '') // strip protocol
    const safeConfig: any = Object.assign({}, config)
    if (safeConfig.password) safeConfig.password = safeConfig.password.replace(/./g, '*')
    logger.info('[driver] Connecting', safeConfig)
    ddp = new Socket(config)
    subscriptions = ddp.subscriptions
    setupMethodCache(ddp) // init instance for later caching method calls
    ddp.open().catch((err) => {
      logger.error(`[driver] Failed to connect: ${err.message}`)
      reject(err)
    })
    ddp.on('open', () => events.emit('connected')) // echo ddp event

    let cancelled = false
    const rejectionTimeout = setTimeout(function () {
      logger.info(`[driver] Timeout (${config.timeout})`)
      const err = new Error('Socket connection timeout')
      cancelled = true
      events.removeAllListeners('connected')
      callback ? callback(err, ddp) : reject(err)
    }, config.timeout)

    // if to avoid condition where timeout happens before listener to 'connected' is added
    // and this listener is not removed (because it was added after the removal)
    if (!cancelled) {
      events.once('connected', () => {
        logger.info('[driver] Connected')
        if (cancelled) return ddp.close() // cancel if already rejected
        clearTimeout(rejectionTimeout)
        if (callback) callback(null, ddp)
        resolve(ddp)
      })
    }
  })
}

/**
 * Setup method cache configs from env or defaults, before they are called.
 * @param ddp The socket instance to cache `.call` results
 */
export function setupMethodCache (ddp: Socket): void {
  logger.debug('[driver] Setting up method catch')
  methodCache.use(ddp)
  methodCache.create('getRoomIdByNameOrId', {
    max: settings.roomCacheMaxSize,
    maxAge: settings.roomCacheMaxAge
  }),
  methodCache.create('getRoomNameById', {
    max: settings.roomCacheMaxSize,
    maxAge: settings.roomCacheMaxAge
  })
  methodCache.create('createDirectMessage', {
    max: settings.dmCacheMaxSize,
    maxAge: settings.dmCacheMaxAge
  })
}

/**
 * Wraps method calls to ensure they return a Promise with caught exceptions.
 * @param method The Rocket.Chat server method, to call through socket
 * @param params Single or array of parameters of the method to call
 */
export function asyncCall (method: string, params: any) {
  if (!Array.isArray(params)) params = [params] // cast to array for apply
  logger.debug(`[${method}] Calling (async): ${JSON.stringify(params)}`)
  return ddp.call(method, ...params)
    .catch((err) => {
      logger.error(`[${method}] Error:`, err)
      throw err // throw after log to stop async chain
    })
    .then((result) => {
      (result)
        ? logger.debug(`[${method}] Success: ${JSON.stringify(result)}`)
        : logger.debug(`[${method}] Success`)
      return result
    })
}

/**
 * Call a method as async via socket, or through cache if one is created.
 * If the method doesn't have or need parameters, it can't use them for caching
 * so it will always call asynchronously.
 * @param name The Rocket.Chat server method to call
 * @param params Single or array of parameters of the method to call
 */
export function callMethod (name: string, ...params: any[]): Promise<any> {
  return (methodCache.has(name) && typeof params[0] !== 'undefined')
    ? cacheCall(name, params[0])
    : asyncCall(name, params)
}

/**
 * Wraps socket method calls, passed through method cache if cache is valid.
 * @param method The Rocket.Chat server method, to call through socket
 * @param key Single string parameters only, required to use as cache key
 */
export function cacheCall (method: string, key: string): Promise<any> {
  logger.debug(`[driver] returning cached result for ${method}(${key})`)
  return methodCache.call(method, key)
    .catch((err: Error) => {
      logger.error(`[${method}] Error:`, err)
      throw err // throw after log to stop async chain
    })
    .then((result: any) => {
      (result)
        ? logger.debug(`[${method}] Success: ${JSON.stringify(result)}`)
        : logger.debug(`[${method}] Success`)
      return result
    })
}

/** Login to Rocket.Chat via DDP */
export async function login (credentials: ICredentials = {
  username: settings.username,
  password: settings.password,
  ldap: settings.ldap
}) {
  let login: ILoginResult | undefined
  if (!ddp || !ddp.connected) await connect()
  if (credentials.ldap) {
    logger.info(`[driver] Logging in ${credentials.username} with LDAP`)
    login = await ddp.login({
      ldap: true,
      ldapOptions: credentials.ldapOptions || {},
      ldapPass: credentials.password,
      username: credentials.username
    })
  } else {
    logger.info(`[driver] Logging in ${credentials.username}`)
    login = await ddp.login(credentials)
  }
  userId = login.id
  return userId
}

/** Proxy socket logout */
export const logout = async () => {
  await unsubscribeAll()
  return ddp.logout()
}

/** Remove all active subscriptions, logout and disconnect from Rocket.Chat */
export function disconnect () {
  logger.info('Unsubscribing, logging out, disconnecting')
  unsubscribeAll().catch((err) => logger.error(`[driver] Failed unsubscribe on disconnect: ${err.message}`))
  return logout()
}

/**
 * Subscribe to Meteor stream. Proxy for socket subscribe.
 * @deprecated Use `ddp.Socket` instance subscribe instead.
 */
export function subscribe (
  topic: string,
  roomId: string
) {
  logger.info(`[driver] Subscribing to ${topic} | ${roomId}`)
  return ddp.subscribe(topic, [roomId, true]).then(({ id }) => id)
}

/** Unsubscribe from Meteor stream. Proxy for socket unsubscribe. */
export function unsubscribe (subscription: ISubscription) {
  return ddp.unsubscribe(subscription.id)
}

/** Unsubscribe from all subscriptions. Proxy for socket unsubscribeAll */
export function unsubscribeAll () {
  return ddp.unsubscribeAll()
}

/** Begin subscription to user's "global" message stream. Will only allow one. */
export async function subscribeToMessages () {
  if (!messages) {
    messages = await ddp.subscribe(
      _messageCollectionName,
      [_messageStreamName, true],
      (data) => logger.debug(`[driver] subscription event ${JSON.stringify(data)}`)
    )
  }
  // make sure singleton messages instance removes itself if unsubscribed
  messages.unsubscribe = async function () {
    await ddp.unsubscribe(this.id)
    messages = undefined
  }
  return messages
}

/**
 * Add callback for changes in the message stream, subscribing if not already.
 * This can be called directly for custom extensions, but for most usage (e.g.
 * for bots) the respondToMessages is more useful to only receive messages
 * matching configuration.
 *
 * @param callback Function called with every change in subscriptions.
 *  - Uses error-first callback pattern
 *  - Second argument is the changed message
 *  - Third argument is additional attributes, such as `roomType`
 */
export async function reactToMessages (callback: IMessageCallback) {
  const handler = (e: ISubscriptionEvent) => {
    try {
      const message: IMessage = e.fields.args[0]
      const meta: IMessageMeta = e.fields.args[1]
      if (!message || !meta || !message._id || !meta.roomType) {
        callback(new Error('Message handler fired on event without message or meta data'))
      } else {
        callback(null, message, meta)
      }
    } catch (err) {
      logger.error(`[driver] Message handler err: ${err.message}`)
      callback(err)
    }
  }
  messages = await subscribeToMessages()
  messages.onEvent(handler)
  logger.info(`[driver] Added event handler for ${messages.name} subscription`)
}

/**
 * Applies `reactToMessages` with some filtering of messages based on config.
 * If no rooms are joined at this point, it will attempt to join now based on
 * environment config, otherwise it might not receive any messages. It doesn't
 * matter that this happens asynchronously because joined rooms can change after
 * the subscription is set up.
 *
 * @param callback Function called after filters run on subscription events.
 *  - Uses error-first callback pattern
 *  - Second argument is the changed item
 *  - Third argument is additional attributes, such as `roomType`
 * @param options Sets filters for different event/message types.
 */
export async function respondToMessages (
  callback: IMessageCallback,
  options: IRespondOptions = {}
) {
  const config = Object.assign({}, settings, options)

  // Join configured rooms if they haven't been already, unless listening to all
  // public rooms, in which case it doesn't matter
  if (
    !config.allPublic &&
    joinedIds.length === 0 &&
    config.rooms &&
    config.rooms.length > 0
  ) {
    await joinRooms(config.rooms)
      .catch((err) => {
        logger.error(`[driver] Failed to join configured rooms (${config.rooms.join(', ')}): ${err.message}`)
      })
  }

  lastReadTime = new Date() // init before any message read
  return reactToMessages(async (err, message, meta) => {
    if (err) {
      logger.error(`[driver] Unable to receive: ${err.message}`)
      return callback(err) // bubble errors back to adapter
    }
    if (typeof message === 'undefined' || typeof meta === 'undefined') {
      logger.error(`[driver] Message or meta undefined`)
      return callback(err)
    }

    // Ignore bot's own messages
    if (message.u && message.u._id === userId) return

    // Ignore DMs unless configured not to
    const isDM = meta.roomType === 'd'
    if (isDM && !config.dm) return

    // Ignore Livechat unless configured not to
    const isLC = meta.roomType === 'l'
    if (isLC && !config.livechat) return

    // Ignore messages in un-joined public rooms unless configured not to
    if (!config.allPublic && !isDM && !meta.roomParticipant) return

    // Set current time for comparison to incoming
    let currentReadTime = (message.ts) ? new Date(message.ts.$date) : new Date()

    // Ignore edited messages if configured to
    if (!config.edited && typeof message.editedAt !== 'undefined') return

    // Ignore messages in stream that aren't new
    if (currentReadTime <= lastReadTime) return

    // At this point, message has passed checks and can be responded to
    const username = (message.u) ? message.u.username : 'unknown'
    logger.info(`[driver] Message ${message._id} from ${username}`)
    lastReadTime = currentReadTime

    // Processing completed, call callback to respond to message
    callback(null, message, meta)
  })
}

/** Get ID for a room by name (or ID). */
export function getRoomId (name: string): Promise<string> {
  return cacheCall('getRoomIdByNameOrId', name)
}

/** Get name for a room by ID. */
export function getRoomName (id: string): Promise<string> {
  return cacheCall('getRoomNameById', id)
}

/**
 * Get ID for a DM room by its recipient's name.
 * Will create a DM (with the bot) if it doesn't exist already.
 * @todo test why create resolves with object instead of simply ID
 */
export function getDirectMessageRoomId (username: string): Promise<string> {
  return cacheCall('createDirectMessage', username)
    .then((DM) => DM.rid)
}

/** Join the bot into a room by its name or ID */
export async function joinRoom (room: string): Promise<void> {
  let roomId = await getRoomId(room)
  let joinedIndex = joinedIds.indexOf(room)
  if (joinedIndex !== -1) {
    logger.error(`[driver] Join room failed, already joined`)
  } else {
    await asyncCall('joinRoom', roomId)
    joinedIds.push(roomId)
  }
}

/** Exit a room the bot has joined */
export async function leaveRoom (room: string): Promise<void> {
  let roomId = await getRoomId(room)
  let joinedIndex = joinedIds.indexOf(room)
  if (joinedIndex === -1) {
    logger.error(`[driver] Leave room failed, bot has not joined ${room}`)
  } else {
    await asyncCall('leaveRoom', roomId)
    delete joinedIds[joinedIndex]
  }
}

/** Join a set of rooms by array of names or IDs */
export function joinRooms (rooms: string[]): Promise<void[]> {
  return Promise.all(rooms.map((room) => joinRoom(room)))
}

/**
 * Structure message content, optionally addressing to room ID.
 * Accepts message text string or a structured message object.
 */
export function prepareMessage (
  content: string | IMessage,
  roomId?: string
): Message {
  const message = new Message(content, integrationId)
  if (roomId) message.setRoomId(roomId)
  return message
}

/**
 * Send a prepared message object (with pre-defined room ID).
 * Usually prepared and called by sendMessageByRoomId or sendMessageByRoom.
 */
export function sendMessage (message: IMessage) {
  return (asyncCall('sendMessage', message) as Promise<IMessageReceipt>)
}

/**
 * Prepare and send string/s to specified room ID.
 * @param content Accepts message text string or array of strings.
 * @param roomId  ID of the target room to use in send.
 * @todo Returning one or many gets complicated with type checking not allowing
 *       use of a property because result may be array, when you know it's not.
 *       Solution would probably be to always return an array, even for single
 *       send. This would be a breaking change, should hold until major version.
 */
export function sendToRoomId (
  content: string | string[] | IMessage,
  roomId: string
): Promise<IMessageReceipt[] | IMessageReceipt> {
  if (!Array.isArray(content)) {
    return sendMessage(prepareMessage(content, roomId))
  } else {
    return Promise.all(content.map((text) => {
      return sendMessage(prepareMessage(text, roomId))
    }))
  }
}

/**
 * Prepare and send string/s to specified room name (or ID).
 * @param content Accepts message text string or array of strings.
 * @param room    A name (or ID) to resolve as ID to use in send.
 */
export function sendToRoom (
  content: string | string[] | IMessage,
  room: string
): Promise<IMessageReceipt[] | IMessageReceipt> {
  return getRoomId(room)
    .then((roomId) => sendToRoomId(content, roomId))
}

/**
 * Prepare and send string/s to a user in a DM.
 * @param content   Accepts message text string or array of strings.
 * @param username  Name to create (or get) DM for room ID to use in send.
 */
export function sendDirectToUser (
  content: string | string[] | IMessage,
  username: string
): Promise<IMessageReceipt[] | IMessageReceipt> {
  return getDirectMessageRoomId(username)
    .then((rid) => sendToRoomId(content, rid))
}

/**
 * Edit an existing message, replacing any attributes with those provided.
 * The given message object should have the ID of an existing message.
 */
export function editMessage (message: IMessage): Promise<IMessage> {
  return asyncCall('updateMessage', message)
}

/**
 * Send a reaction to an existing message. Simple proxy for method call.
 * @param emoji     Accepts string like `:thumbsup:` to add 👍 reaction
 * @param messageId ID for a previously sent message
 */
export function setReaction (emoji: string, messageId: string) {
  return asyncCall('setReaction', [emoji, messageId])
}
