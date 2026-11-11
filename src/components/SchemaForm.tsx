import { useState } from 'react'
import { useFacility } from '../api'
import { facilityLimitProblem, valueUnavailable } from '../model/facility'
import { allowedChoices, allowedProblem, applies, isSecretRef, SECRET_FORMAT, titleFor, validateValue } from '../model/schema'
import type { JsonSchema, JsonValue } from '../model/types'

type ObjectValue = { [key: string]: JsonValue }

// Choices that come from the instance, by `x-options` source (e.g. its input copies in use).
export type SchemaChoices = Partial<Record<'inputs', { value: string; label: string }[]>>

// Form for an object schema (the JSON Schema subset in types.ts). Anything the form cannot
// represent (arrays, untyped values) is edited as JSON.
// `root` is the whole parameters object, for conditions that look at another group (x-when "srt.bonding").
export function SchemaForm({ schema, value, onChange, root = value, choices }: { schema: JsonSchema; value: ObjectValue; onChange: (v: ObjectValue) => void; root?: ObjectValue; choices?: SchemaChoices }) {
  // Fields with an `x-when` condition only show while their siblings match it.
  const props = Object.entries(schema.properties ?? {}).filter(([, s]) => applies(s, value, root))
  if (!props.length) return <p className="hint">No parameters.</p>
  const field = ([key, s]: [string, JsonSchema]) => (
    <SchemaField
      key={key}
      name={key}
      schema={schema['x-allowed'] ? { ...s, enum: allowedChoices(schema, key, value) } : s}
      choices={choices}
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
  // A combination of fields that isn't valid (e.g. a frame rate the product has no format for).
  const combination = allowedProblem(schema, value)
  if (combination) rows.push(<p key="x-allowed" className="error-text">{combination}</p>)
  return <>{rows}</>
}

const AUDIENCE: Record<string, string> = {
  function: 'injected into the media function',
  orchestrator: 'for the orchestrator',
  both: 'media function + orchestrator',
}

type FieldProps = {
  name: string
  schema: JsonSchema
  required: boolean
  value: JsonValue | undefined
  siblings: ObjectValue
  root: ObjectValue
  choices?: SchemaChoices
  onChange: (v: JsonValue | undefined) => void
}

function SchemaField({ name, schema, required, value, siblings, root, choices, onChange }: FieldProps) {
  const facility = useFacility()
  const label = (
    <span>
      {titleFor(schema, siblings, root) ?? name}
      {required && <span className="required">*</span>}
      {schema.type !== 'object' && schema['x-audience'] && <span className={`audience ${schema['x-audience']}`}>{AUDIENCE[schema['x-audience']]}</span>}
    </span>
  )
  const errors = required && value === undefined && schema.type !== 'object' ? [`${name}: required`] : validateValue(schema, value, name, root)
  const overLimit = facilityLimitProblem(schema, value, facility)
  if (overLimit) errors.push(`${name}: ${overLimit}`)
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
  if (schema['x-options']) {
    const options = choices?.[schema['x-options']] ?? []
    const known = options.some((o) => o.value === value)
    return (
      <label className="field">
        {label}
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{schema['x-emptyLabel'] ?? (options[0] ? `First (${options[0].label})` : '—')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {typeof value === 'string' && value && !known && <option value={value}>{value} (not in use)</option>}
        </select>
        {typeof value === 'string' && value && !known ? <span className="error-text">{value} isn't an input copy in use</span> : hint}
      </label>
    )
  }
  if (schema.enum) {
    // Values the facility doesn't offer (x-enumNeeds) can't be chosen; the current one stays shown.
    const why = (o: string | number) => valueUnavailable(schema, o, facility)
    const current = value === undefined ? (schema.default as string | number | undefined) : (value as string | number)
    const currentWhy = current !== undefined ? why(current) : null
    const others = schema.enum.filter((o) => o !== current && why(o))
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
            <option key={String(o)} value={String(o)} disabled={o !== value && !!why(o)}>
              {String(o)}
              {why(o) ? ' (not offered)' : ''}
            </option>
          ))}
        </select>
        {currentWhy ? <span className="error-text">{`${String(current)} ${currentWhy}`}</span> : hint}
        {others.map((o) => (
          <span key={String(o)} className="unavailable">{`Not offered: ${String(o)} ${why(o)}`}</span>
        ))}
      </label>
    )
  }
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
                  {AUDIENCE[schema['x-audience']]}
                </span>
              )}
            </legend>
            {schema.description && <p className="hint">{schema.description}</p>}
            <SchemaForm
              root={root}
              choices={choices}
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
