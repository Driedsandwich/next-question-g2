import type { Engine } from './engine.ts'
import type { Announcer, SourceName } from './types.ts'

/** The part of the engine a question source may use. Sources never see the queue or the glasses. */
export type Sink = Pick<Engine, 'ask' | 'vote' | 'startSession' | 'endSession' | 'getState'>

export interface QuestionSource {
  readonly name: SourceName
  readonly announcer: Announcer
  start(sink: Sink): Promise<void> | void
  stop(): void
}
