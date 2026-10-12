import { useState } from 'react'
import { applies, isSecretRef, SECRET_FORMAT, titleFor, validateValue } from '../model/schema'
import type { JsonSchema, JsonValue } from '../model/types'

type ObjectValue = { [key: string]: JsonValue }

// Form for an object schema (the JSON Schema subset in types.ts). Anything the form cannot
// represent (arrays, untyped values) is edited as JSON.
// `root` is the whole parameters object, for conditions that look at another group (x-when "srt.bonding").
export function SchemaForm({ schema, value, onChange, root = value }: { schema: JsonSchema; value: ObjectValue; onChange: (v: ObjectValue) => void; root?: ObjectValue }) {
  // Fields with an `x-when` condition only show while their siblings match it.
  const props = Object.entries(schema.properties ?? {}).filter(([, s]) => applies(s, value, root))
  if (!props.length) return <p className="hint">No parameters.</p>
  const field = ([key, s]: [string, JsonSchema]) => (
    <SchemaField
      key={key}
      name={key}
      schema={s}
      required={schema.required?.includes(key) ?? false}
      value={value[key]}
      siblings={value}
      root={root}
      onChange={(v) => {
        const next = { ...value }
        if (v === undefined) delete next[key]
        else next[key] = v
        onChange(next)
      }}
    />
  )
  // Consecutive properties of the same `x-group` (e.g. Path A | Path B) are laid out together.
  const rows: React.ReactNode[] = []
  for (let i = 0; i < props.length; ) {
    const group = props[i][1]['x-group']
    if (!group) {
      rows.push(field(props[i++]))
      continue
    }
    const members: [string, JsonSchema][] = []
    while (i < props.length && props[i][1]['x-group'] === group) members.push(props[i++])
    rows.push(
      <div key={`group:${group}:${members[0][0]}`} className={`param-group members-${members.length}`}>
        {members.map(field)}
      </div>,
    )
  }
  return <>{rows}</>
}

type FieldProps = {
  name: string
  schema: JsonSchema
  required: boolean
  value: JsonValue | undefined
  siblings: ObjectValue
  root: ObjectValue
  onChange: (v: JsonValue | undefined) => void
}

function SchemaField({ name, schema, required, value, siblings, root, onChange }: FieldProps) {
  const label = (
    <span>
      {titleFor(schema, siblings, root) ?? name}
      {required && <span className="required">*</span>}
    </span>
  )
  const errors = required && value === undefined && schema.type !== 'object' ? [`${name}: required`] : validateValue(schema, value, name, root)
  const hint = errors.length ? <span className="error-text">{errors[0].replace(`${name}: `, '')}</span> : schema.description && <span className="hint">{schema.description}</span>

  if (schema.format === SECRET_FORMAT)
    return (
      <label className="field">
        {label}
        <input
          placeholder="secret name"
          value={isSecretRef(value) ? value.$secret : ''}
          onChange={(e) => onChange(e.target.value ? { $secret: e.target.value } : undefined)}
        />
        <span className="hint">Secret reference, resolved by the orchestrator. Never the value itself.</span>
      </label>
    )
  if (schema.enum)
    return (
      <label className="field">
        {label}
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            const v = schema.enum!.find((o) => String(o) === e.target.value)
            onChange(v)
          }}
        >
          {!required && <option value="">—</option>}
          {schema.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
        {hint}
      </label>
    )
  switch (schema.type) {
    case 'boolean':
      return (
        <label className="field field-check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      )
    case 'string':
      return (
        <label className="field">
          {label}
          <input value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
          {hint}
        </label>
      )
    case 'number':
    case 'integer':
      return (
        <label className="field">
          {label}
          <input
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            step={schema.type === 'integer' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber)}
          />
          {hint}
        </label>
      )
    case 'object':
      if (schema.properties)
        return (
          <fieldset className={`nested${schema['x-group'] ? ` in-group key-${name}` : ''}`}>
            <legend>
              {label}
              {schema['x-audience'] && (
                <span className={`audience ${schema['x-audience']}`}>
                  {
                    {
                      function: 'injected into the media function',
                      orchestrator: 'for the orchestrator',
                      both: 'media function + orchestrator',
                    }[schema['x-audience']]
                  }
                </span>
              )}
            </legend>
            {schema.description && <p className="hint">{schema.description}</p>}
            <SchemaForm
              root={root}
              schema={schema}
              value={value && typeof value === 'object' && !Array.isArray(value) ? value : {}}
              onChange={(v) => onChange(v)}
            />
          </fieldset>
        )
  }
  return <JsonField label={label} value={value} hint={hint} onChange={onChange} />
}

function JsonField({ label, value, hint, onChange }: { label: React.ReactNode; value: JsonValue | undefined; hint: React.ReactNode; onChange: (v: JsonValue | undefined) => void }) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)))
  const [bad, setBad] = useState(false)
  return (
    <label className="field">
      {label}
      <textarea
        className="json"
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (!e.target.value.trim()) {
            setBad(false)
            return onChange(undefined)
          }
          try {
            onChange(JSON.parse(e.target.value))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
      {bad ? <span className="error-text">Not valid JSON yet.</span> : hint}
    </label>
  )
}
