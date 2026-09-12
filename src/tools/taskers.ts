// Tasker discovery. A fixture-backed search over TaskerProfile records,
// keyed by task class, plus the scoring function used to rank candidates
// that have already passed vet().

import type { TaskerProfile } from '../trust.js'

export interface TaskerSearch {
  find(taskClass: string): Promise<TaskerProfile[]>
  get(id: string): TaskerProfile | undefined
}

export class FixtureTaskers implements TaskerSearch {
  constructor(private readonly profiles: readonly TaskerProfile[]) {}

  async find(taskClass: string): Promise<TaskerProfile[]> {
    return this.profiles.filter((p) => p.taskClasses.includes(taskClass))
  }

  get(id: string): TaskerProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }
}

// Only meaningful after vet() has passed; ranks otherwise-qualified taskers.
export function scoreTasker(p: TaskerProfile): number {
  return p.rating * 20 + Math.min(p.jobs, 300) / 10 + p.yearsActive * 2
}
