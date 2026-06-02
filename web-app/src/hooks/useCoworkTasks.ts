import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type CoworkTaskStatus = 'pending' | 'running' | 'completed'

export type CoworkTask = {
  id: string
  title: string
  status: CoworkTaskStatus
  createdAt: number
}

type CoworkTasksState = {
  tasks: CoworkTask[]
  addTask: (title: string) => CoworkTask
  updateTask: (id: string, updates: Partial<Omit<CoworkTask, 'id' | 'createdAt'>>) => void
  deleteTask: (id: string) => void
}

export const useCoworkTasks = create<CoworkTasksState>()(
  persist(
    (set) => ({
      tasks: [],
      addTask: (title) => {
        const task: CoworkTask = {
          id: crypto.randomUUID(),
          title,
          status: 'pending',
          createdAt: Date.now(),
        }
        set((state) => ({ tasks: [task, ...state.tasks] }))
        return task
      },
      updateTask: (id, updates) => {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }))
      },
      deleteTask: (id) => {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }))
      },
    }),
    {
      name: 'cowork-tasks',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
