import { get, post, login, logout } from '../lib/api'
import { apiUser, botUser, mockUser } from './config'
import {
  IMessageAPI,
  IMessageUpdateAPI,
  IMessageResultAPI,
  INewUserAPI,
  IUserResultAPI,
  IRoomResultAPI,
  IChannelResultAPI,
  IGroupResultAPI,
  IHistoryAPI,
  IMessageReceipt
} from '../interfaces'
import { Socket } from '../lib/ddp'

/** Define common attributes for DRY tests */
export const testChannelName = 'tests'
export const testPrivateName = 'p-tests'

/** Get information about a user */
export async function userInfo (username: string) {
  return (await get('users.info', { username }, true) as IUserResultAPI)
}

/** Create a user and catch the error if they exist already */
export async function createUser (user: INewUserAPI) {
  const result: IUserResultAPI = await post('users.create', user, true, /already in use/i)
  return result
}

/** Get information about a channel */
export async function channelInfo (query: { roomName?: string, roomId?: string }) {
  return (await get('channels.info', query, true) as IChannelResultAPI)
}

/** Get information about a private group */
export async function privateInfo (query: { roomName?: string, roomId?: string }) {
  return (await get('groups.info', query, true) as IGroupResultAPI)
}

/** Get the last messages sent to a channel (in last 10 minutes) */
export async function lastMessages (roomId: string, count: number = 1) {
  const now = new Date()
  const latest = now.toISOString()
  const oldest = new Date(now.setMinutes(now.getMinutes() - 10)).toISOString()
  const history = (await get('channels.history', { roomId, latest, oldest, count }) as IHistoryAPI)
  return history.messages
}

/** Create a room for tests and catch the error if it exists already */
export async function createChannel (
  name: string,
  members: string[] = [],
  readOnly: boolean = false
) {
  return (await post('channels.create', { name, members, readOnly }, true) as IChannelResultAPI)
}

/** Create a private group / room and catch if exists already */
export async function createPrivate (
  name: string,
  members: string[] = [],
  readOnly: boolean = false
) {
  return (await post('groups.create', { name, members, readOnly }, true) as IGroupResultAPI)
}

/** Send message from mock user to channel for tests to listen and respond */
/** @todo Sometimes the post request completes before the change event emits
 *        the message to the streamer. That's why the interval is used for proof
 *        of receipt. It would be better for the endpoint to not resolve until
 *        server side handling is complete. Would require PR to core.
 */
export async function sendFromUser (payload: any): Promise<IMessageResultAPI> {
  const user = await login({ username: mockUser.username, password: mockUser.password })
  const endpoint = (payload.roomId && payload.roomId.indexOf(user.data.userId) !== -1)
    ? 'dm.history'
    : 'channels.history'
  const roomId = (payload.roomId)
    ? payload.roomId
    : (await channelInfo({ roomName: testChannelName })).channel._id
  const messageDefaults: IMessageAPI = { roomId }
  const data: IMessageAPI = Object.assign({}, messageDefaults, payload)
  const oldest = new Date().toISOString()
  const result = (await post('chat.postMessage', data, true) as IMessageResultAPI)
  const proof = new Promise((resolve, reject) => {
    let looked = 0
    const look = setInterval(async () => {
      const { messages } = (await get(endpoint, { roomId, oldest }) as IHistoryAPI)
      const found = messages.some((message: IMessageReceipt) => {
        return result.message._id === message._id
      })
      if (found || looked > 10) {
        clearInterval(look)
        if (found) resolve()
        else reject('API send from user, proof of receipt timeout')
      }
      looked++
    }, 100)
  })
  await proof
  return result
}

/** Leave user from room, to generate `ul` message (test channel by default) */
export async function leaveUser (room: { id?: string, name?: string } = {}) {
  await login({ username: mockUser.username, password: mockUser.password })
  if (!room.id && !room.name) room.name = testChannelName
  const roomId = (room.id)
    ? room.id
    : (await channelInfo({ roomName: room.name })).channel._id
  return (await post('channels.leave', { roomId }) as Boolean)
}

/** Invite user to room, to generate `au` message (test channel by default) */
export async function inviteUser (room: { id?: string, name?: string } = {}) {
  let mockInfo = await userInfo(mockUser.username)
  await login({ username: apiUser.username, password: apiUser.password })
  if (!room.id && !room.name) room.name = testChannelName
  const roomId = (room.id)
    ? room.id
    : (await channelInfo({ roomName: room.name })).channel._id
  return (await post('channels.invite', { userId: mockInfo.user._id, roomId }) as boolean)
}

/** @todo : Join user into room (enter) to generate `uj` message type. */

/** Update message sent from mock user */
export async function updateFromUser (payload: IMessageUpdateAPI) {
  await login({ username: mockUser.username, password: mockUser.password })
  return (await post('chat.update', payload, true) as IMessageResultAPI)
}

/** Create a direct message session with the mock user */
export async function setupDirectFromUser () {
  await login({ username: mockUser.username, password: mockUser.password })
  return (await post('im.create', { username: botUser.username }, true) as IRoomResultAPI)
}

/** Initialise testing instance with the required users for SDK/bot tests */
export async function setup () {
  console.log('\nPreparing instance for tests...')

  // Verify API user can login
  try {
    await login(apiUser)
    console.log(`API user (${apiUser.username}) logged in`)
  } catch (err) {
    throw new Error(`API user (${apiUser.username}) could not login: ${err.errorType}`)
  }

  // Verify or create user for bot
  try {
    await userInfo(botUser.username)
    console.log(`Bot user (${botUser.username}) exists`)
  } catch (err) {
    console.log(`Bot user (${botUser.username}) not found: ${err.errorType}`)
    await createUser(botUser)
    console.log(`Bot user (${botUser.username}) created`)
  }

  // Verify or create mock user for talking to bot
  try {
    await userInfo(mockUser.username)
    console.log(`Mock user (${mockUser.username}) exists`)
  } catch (err) {
    console.log(`Mock user (${mockUser.username}) not found: ${err.errorType}`)
    await createUser(mockUser)
    console.log(`Mock user (${mockUser.username}) created`)
  }

  // Verify or create channel for tests
  try {
    await channelInfo({ roomName: testChannelName })
    console.log(`Test channel (${testChannelName}) exists`)
  } catch (err) {
    console.log(`Test channel (${testChannelName}) not found: ${err.errorType}`)
    await createChannel(testChannelName, [
      apiUser.username, botUser.username, mockUser.username
    ])
    console.log(`Test channel (${testChannelName}) created`)
  }

  // Verify or create private room for tests
  try {
    await privateInfo({ roomName: testPrivateName })
    console.log(`Test private room (${testPrivateName}) exists`)
  } catch (err) {
    console.log(`Test private room (${testPrivateName}) not found: ${err.errorType}`)
    await createPrivate(testPrivateName, [
      apiUser.username, botUser.username, mockUser.username
    ])
    console.log(`Test private room (${testPrivateName}) created`)
  }

  // End of API setup usage
  await logout()

  // Assign bot user as livechat agent
  try {
    const socket = new Socket()
    await socket.open()
    await socket.login({ username: apiUser.username, password: apiUser.password })
    await socket.call('livechat:addAgent', botUser.username)
    console.log('Bot user assigned as livechat agent')
    await socket.close()
  } catch (err) {
    console.log('Could not assign bot user as livechat agent')
    throw err
  }

  process.exit()
}
