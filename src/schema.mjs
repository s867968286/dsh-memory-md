/**
 * schema 辅助：把 spec 形式的参数描述转成 DSH 接受的 JSON Schema。
 *
 * 为什么不用 `defineTool`：`@deepseek-ai/dsh-tools` **不在 profile 的可解析范围内**
 * （profile 只暴露 cosmokit 与 schemastery），插件的 `import` 一定失败。而
 * `ctx.tools.register()` 接受的就是**纯 JSON Schema**（它内部调
 * `assertSupportedJsonSchema`，不是 spec 转换器），所以这里自己做转换。
 *
 * 转换规则（DSH 编译器的硬性要求）：
 * - 可选字段必须**完全不写 required**；写 `required: false` 会被拒绝
 * - `required` 只能用 `true`
 * - 对象根必须是 `{ type: 'object', properties, additionalProperties: false }`
 *
 * 转换结果在 `test/tools.test.mjs` 里过一遍真实的 `assertSupportedJsonSchema`，
 * 保证形状正确，而不是靠约定。
 */

/**
 * 把一个 spec 节点转成 JSON Schema 节点。
 *
 * spec 形状：`{ type, description?, required?, enum?, items?, properties? }`
 */
function toJsonSchemaNode(spec, key) {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError(`schema spec for "${key}" must be an object`)
  }

  const node = {}
  if (spec.type !== undefined) node.type = spec.type
  if (spec.description !== undefined) node.description = spec.description
  if (spec.enum !== undefined) node.enum = [...spec.enum]

  if (spec.type === 'array') {
    if (spec.items === undefined) throw new TypeError(`array "${key}" must declare items`)
    node.items = toJsonSchemaNode(spec.items, `${key}[]`)
  }

  if (spec.type === 'object') {
    const properties = spec.properties ?? {}
    const requiredNames = []
    const out = {}
    for (const [name, child] of Object.entries(properties)) {
      out[name] = toJsonSchemaNode(child, `${key}.${name}`)
      // 只把显式 required:true 的字段列进 required。
      if (child.required === true) requiredNames.push(name)
    }
    node.properties = out
    node.additionalProperties = false
    if (requiredNames.length > 0) node.required = requiredNames
  }

  return node
}

/** 把参数 spec 映射转成对象根 JSON Schema。 */
export function parametersToJsonSchema(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    properties[name] = toJsonSchemaNode(spec, name)
    if (spec.required === true) required.push(name)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * 输出 schema 归一化。
 *
 * 输出 schema 在源码里写成**完整 JSON Schema**（根就是
 * `{ type: 'object', additionalProperties: false, properties: {...} }`），
 * 与参数用的 spec 形式不同。但属性上仍带着 spec 风格的 `required: true`，
 * 而 DSH 不允许属性节点带 `required`：
 *   `schema.properties.file.required is not supported on type "string"`
 *
 * 所以这里做一次归一化：把属性上的 `required: true` 提到对象根的 `required` 数组，
 * 并补齐 `additionalProperties: false`。
 */
export function normalizeOutputSchema(schema) {
  if (schema === null || typeof schema !== 'object') {
    throw new TypeError('output schema must be an object')
  }
  if (schema.type !== 'object') {
    throw new TypeError('output schema root must be an object')
  }

  const properties = {}
  const required = []
  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    const { required: isRequired, ...rest } = node
    if (isRequired === true) required.push(name)
    if (rest.type === 'array' && rest.items !== undefined) {
      rest.items = normalizeOutputSchema(
        // 数组元素同样可能是对象根
        rest.items.type === 'object'
          ? rest.items
          : { type: 'object', properties: rest.items, additionalProperties: false },
      )
    }
    properties[name] = rest
  }

  const normalized = {
    type: 'object',
    properties,
    additionalProperties: false,
  }
  if (required.length > 0) normalized.required = required
  return normalized
}
