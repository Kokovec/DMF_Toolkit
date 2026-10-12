import { useEffect, useState } from 'react'
import { api, describeError, type WorkloadSummary } from '../api'

type Props = { onOpen: (id: string) => void; onClose: () => void }

export function WorkloadBrowser({ onOpen, onClose }: Props) {
  const [items, setItems] = useState<WorkloadSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = () => api.workloads().then(setItems, (e) => setError(describeError(e)))
  useEffect(() => {
    load()
  }, [])

  const remove = async (id: string) => {
    try {
      await api.deleteWorkload(id)
      setConfirmDelete(null)
      load()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Open workload" onClick={(e) => e.stopPropagation()}>
        <h2>Saved workloads</h2>
        {error && <p className="error-text">{error}</p>}
        {items?.length === 0 && <p className="hint">Nothing saved yet. Use Save to store the current workload.</p>}
        <ul className="workload-list">
          {items?.map((w) => (
            <li key={w.id}>
              <div>
                <strong>{w.name}</strong>
                <div className="hint">
                  {w.id} · revision {w.revision} · {new Date(w.updatedAt).toLocaleString()}
                </div>
              </div>
              {confirmDelete === w.id ? (
                <span className="row-actions">
                  <button className="danger" onClick={() => remove(w.id)}>
                    Delete all revisions
                  </button>
                  <button onClick={() => setConfirmDelete(null)}>Keep</button>
                </span>
              ) : (
                <span className="row-actions">
                  <button onClick={() => onOpen(w.id)}>Open</button>
                  <button onClick={() => setConfirmDelete(w.id)}>Delete</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
