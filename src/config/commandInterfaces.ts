/** @todo contribute these to @types/rocketchat and require */

export interface IClientCommand {
  _id: string // generated by Random.id()
  u: {
    _id: string,
    username: string
  }
  cmd: {
    msg: string,
    options: object
  }
  ts: Date
}

export interface IClientCommandResponse {
  status?: number,
  msg: string
}

export interface IClientCommandHandler {
  (command: IClientCommand): Promise<IClientCommandResponse>
}

export interface IClientCommandHandlerMap {
  [key: string]: IClientCommandHandler
}
