import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { api, describeError, refreshCatalog, useCatalog, type CatalogSummary } from '../api'
import { checkCatalog, isEdge } from '../model/catalog'
import { EXTERNALS, EXTERNAL_KINDS } from '../model/externals'
import { getCategory } from '../model/library'
import type { ModuleCatalog, VendorModule } from '../model/types'

// Categories are kept as descriptive tags (shown in the tooltip), not as palette headings.
const categoryNames = (m: VendorModule) => m.categories.map((c) => getCategory(c)?.name ?? c).join(', ')

export const DRAG_MIME = 'application/x-dmf-node' // "fn:<module type id>" or "ext:<external kind>"

type Props = { online: boolean; onMessage: (msg: string, isError: boolean) => void }

export function Palette({ online, onMessage }: Props) {
  const catalog = useCatalog()
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (online) api.catalogs().then(setCatalogs, () => setCatalogs([]))
  }, [online, catalog])

  const importCatalog = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const doc = JSON.parse(await file.text())
      const problems = checkCatalog(doc)
      if (problems.length) return onMessage(`Cannot import ${file.name}: ${problems.slice(0, 3).join('; ')}`, true)
      const r = await api.importCatalog(doc as ModuleCatalog)
      await refreshCatalog()
      onMessage(
        `Imported ${(doc as ModuleCatalog).metadata.name}: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged`,
        false,
      )
    } catch (err) {
      onMessage(err instanceof SyntaxError ? `${file.name} is not valid JSON` : `Import failed: ${describeError(err)}`, true)
    }
  }

  const drag = (value: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, value)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <aside className="palette">
      {/* One heading per company; its products below. Double-click a placed function to configure it. */}
      {catalog.byCompany().length === 0 && <p className="hint">No products yet.</p>}
      {catalog.byCompany().map(({ company, modules }) => (
        <section key={company} className="palette-category">
          <h2>{company}</h2>
          {modules.map((p) => (
            <div
              key={p.id}
              className={`palette-item fn${isEdge(p) ? ' edge' : ''}`}
              draggable
              title={`${p.description}\n${categoryNames(p)} · ${p.id}@${p.version}`}
              onDragStart={drag(`fn:${p.id}`)}
            >
              {p.name}
            </div>
          ))}
        </section>
      ))}

      <h2 className="palette-section">External devices</h2>
      {EXTERNAL_KINDS.map((k) => (
        <div key={k} className="palette-item ext" draggable title={EXTERNALS[k].description} onDragStart={drag(`ext:${k}`)}>
          {EXTERNALS[k].name}
        </div>
      ))}

      <section className="library">
        <h3>Library</h3>
        {online ? (
          <>
            {catalogs.map((c) => (
              <div key={c.id} className="library-item">
                <span title={`${c.id} v${c.version}`}>
                  {c.name} <span className="hint">({c.moduleCount})</span>
                </span>
                <a href={`/api/catalogs/${encodeURIComponent(c.id)}`} download={`${c.id}.catalog.json`}>
                  Export
                </a>
              </div>
            ))}
            <button onClick={() => fileInput.current?.click()}>Import catalog…</button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={importCatalog} />
          </>
        ) : (
          <p className="hint">Offline: no vendor modules. Start the library server with `npm run server`.</p>
        )}
      </section>

      <div className="legend">
        <h3>Legend</h3>
        {(['video', 'audio', 'data'] as const).map((e) => (
          <div key={e} className={`legend-item essence-${e}`}>
            <span className="swatch" /> {e}
          </div>
        ))}
        <div className="legend-item">
          <span className="swatch bundle-swatch" /> bundle (shared time context)
        </div>
      </div>
      <p className="hint">
        Generic functions (dashed) are role placeholders: bind them to a vendor implementation before publishing. Drag between
        bundle handles to wire video + audio together; drag between single ports to split them.
      </p>
    </aside>
  )
}
