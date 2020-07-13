'use strict'

const { format, safe, safeand, safeor, safenot } = require('./safe-format')
const genfun = require('./generate-function')
const { resolveReference, joinPath } = require('./pointer')
const formats = require('./formats')
const functions = require('./scope-functions')
const { scopeMethods } = require('./scope-utils')
const { types, schemaTypes } = require('./types')
const { knownKeywords, schemaVersions, knownVocabularies } = require('./known-keywords')
const { initTracing, andDelta, orDelta, applyDelta, isDynamic } = require('./tracing')

const noopRegExps = new Set(['^[\\s\\S]*$', '^[\\S\\s]*$', '^[^]*$', '', '.*', '^', '$'])

// Helper methods for semi-structured paths
const propvar = (parent, keyname, inKeys = false, number = false) =>
  Object.freeze({ parent, keyname, inKeys, number }) // property by variable
const propimm = (parent, keyval, checked = false) => Object.freeze({ parent, keyval, checked }) // property by immediate value
const buildName = ({ name, parent, keyval, keyname }) => {
  if (name) {
    if (parent || keyval || keyname) throw new Error('name can be used only stand-alone')
    return name // top-level
  }
  if (!parent) throw new Error('Can not use property of undefined parent!')
  const parentName = buildName(parent)
  if (keyval !== undefined) {
    if (keyname) throw new Error('Can not use key value and name together')
    if (!['string', 'number'].includes(typeof keyval)) throw new Error('Invalid property path')
    if (/^[a-z][a-z0-9_]*$/i.test(keyval)) return format('%s.%s', parentName, safe(keyval))
    return format('%s[%j]', parentName, keyval)
  } else if (keyname) {
    return format('%s[%s]', parentName, keyname)
  }
  /* c8 ignore next */
  throw new Error('Unreachable')
}

const jsonProtoKeys = new Set(
  [].concat(
    ...[Object, Array, String, Number, Boolean].map((c) => Object.getOwnPropertyNames(c.prototype))
  )
)

const evaluatedStatic = Symbol('evaluated')

const rootMeta = new WeakMap()
const compile = (schema, root, opts, scope, basePathRoot) => {
  const {
    mode = 'default',
    useDefaults = false,
    removeAdditional = false, // supports additionalProperties: false and additionalItems: false
    includeErrors = false,
    allErrors = false,
    reflectErrorsValue = false,
    dryRun = false,
    allowUnusedKeywords = opts.mode === 'lax',
    requireValidation = opts.mode === 'strong',
    requireStringValidation = opts.mode === 'strong',
    complexityChecks = opts.mode === 'strong',
    unmodifiedPrototypes = false, // assumes no mangled Object/Array prototypes
    isJSON = false, // assume input to be JSON, which e.g. makes undefined impossible
    $schemaDefault = null,
    formats: optFormats = {},
    weakFormats = opts.mode !== 'strong',
    extraFormats = false,
    schemas, // always a Map, produced at wrapper
    ...unknown
  } = opts
  const fmts = {
    ...formats.core,
    ...(weakFormats ? formats.weak : {}),
    ...(extraFormats ? formats.extra : {}),
    ...optFormats,
  }
  if (Object.keys(unknown).length !== 0)
    throw new Error(`Unknown options: ${Object.keys(unknown).join(', ')}`)

  if (!['strong', 'lax', 'default'].includes(mode)) throw new Error(`Invalid mode: ${mode}`)
  if (mode === 'strong' && (!requireValidation || !requireStringValidation || !complexityChecks))
    throw new Error('Strong mode demands require(String)Validation and complexityChecks')
  if (mode === 'strong' && (weakFormats || allowUnusedKeywords))
    throw new Error('Strong mode forbids weakFormats and allowUnusedKeywords')
  if (!includeErrors && (allErrors || reflectErrorsValue))
    throw new Error('allErrors and reflectErrorsValue are not available if includeErrors = false')

  const { gensym, genpattern, genloop, getref, genref, genformat } = scopeMethods(scope)

  const buildPath = (prop) => {
    const path = []
    let curr = prop
    while (curr) {
      if (!curr.name) path.unshift(curr)
      curr = curr.parent || curr.errorParent
    }

    // fast case when there are no variables inside path
    if (path.every((part) => part.keyval !== undefined))
      return format('%j', functions.toPointer(path.map((part) => part.keyval)))

    // Be very careful while refactoring, this code significantly affects includeErrors performance
    // It attempts to construct fast code presentation for paths, e.g. "#/abc/"+pointerPart(key0)+"/items/"+i0
    const stringParts = ['#']
    const stringJoined = () => {
      const value = stringParts.map(functions.pointerPart).join('/')
      stringParts.length = 0
      return value
    }
    let res = null
    for (const { keyname, keyval, number } of path) {
      if (keyname) {
        if (!number) scope.pointerPart = functions.pointerPart
        const value = number ? keyname : format('pointerPart(%s)', keyname)
        const str = `${stringJoined()}/`
        res = res ? format('%s+%j+%s', res, str, value) : format('%j+%s', str, value)
      } else if (keyval) stringParts.push(keyval)
    }
    return stringParts.length > 0 ? format('%s+%j', res, `/${stringJoined()}`) : res
  }

  const present = (location) => {
    const name = buildName(location) // also checks for sanity, do not remove
    const { parent, keyval, keyname, inKeys, checked } = location
    /* c8 ignore next */
    if (checked || (inKeys && isJSON)) throw new Error('Unreachable: useless check for undefined')
    if (inKeys) return format('%s !== undefined', name)
    if (parent && keyname) {
      scope.hasOwn = functions.hasOwn
      return format('%s !== undefined && hasOwn(%s, %s)', name, buildName(parent), keyname)
    } else if (parent && keyval !== undefined) {
      // numbers must be converted to strings for this check, hence `${keyval}` in check below
      if (unmodifiedPrototypes && isJSON && !jsonProtoKeys.has(`${keyval}`))
        return format('%s !== undefined', name)
      scope.hasOwn = functions.hasOwn
      return format('%s !== undefined && hasOwn(%s, %j)', name, buildName(parent), keyval)
    }
    /* c8 ignore next */
    throw new Error('Unreachable: present() check without parent')
  }

  const funname = genref(schema)
  let validate = null // resolve cyclic dependencies
  const wrap = (...args) => {
    const res = validate(...args)
    wrap.errors = validate.errors
    return res
  }
  scope[funname] = wrap

  const fun = genfun()
  fun.write('function validate(data, recursive) {')
  if (includeErrors) fun.write('validate.errors = null')
  if (allErrors) fun.write('let errorCount = 0')

  const recursiveAnchor = schema && schema.$recursiveAnchor === true
  const getMeta = () => rootMeta.get(root) || {}
  const basePathStack = basePathRoot ? [basePathRoot] : []
  const visit = (errors, history, current, node, schemaPath) => {
    // e.g. top-level data and property names, OR already checked by present() in history, OR in keys and not undefined
    const queryCurrent = () => history.filter((h) => h.prop === current)
    const definitelyPresent =
      !current.parent || current.checked || (current.inKeys && isJSON) || queryCurrent().length > 0

    const name = buildName(current)
    const currPropVar = (...args) => propvar(current, ...args)
    const currPropImm = (...args) => propimm(current, ...args)

    const error = ({ path = [], prop = current, source }) => {
      const dataP = buildPath(prop)
      if (includeErrors === true && errors && source) {
        const schemaP = functions.toPointer([...schemaPath, ...path])
        // we can include absoluteKeywordLocation later, perhaps
        scope.errorMerge = functions.errorMerge
        const args = [source, schemaP, dataP]
        if (allErrors) {
          fun.write('if (validate.errors === null) validate.errors = []')
          fun.write('validate.errors.push(...%s.map(e => errorMerge(e, %j, %s)))', ...args)
        } else {
          fun.write('validate.errors = [errorMerge(%s[0], %j, %s)]', ...args)
        }
      } else if (includeErrors === true && errors) {
        const schemaP = functions.toPointer([...schemaPath, ...path])
        const errorJS = reflectErrorsValue
          ? format(
              '{ keywordLocation: %j, instanceLocation: %s, value: %s }',
              schemaP,
              dataP,
              buildName(prop)
            )
          : format('{ keywordLocation: %j, instanceLocation: %s }', schemaP, dataP)
        if (allErrors) {
          fun.write('if (%s === null) %s = []', errors, errors)
          fun.write('%s.push(%s)', errors, errorJS)
        } else {
          // Array assignment is significantly faster, do not refactor the two branches
          fun.write('%s = [%s]', errors, errorJS)
        }
      }
      if (allErrors) fun.write('errorCount++')
      else fun.write('return false')
    }
    const errorIf = (condition, errorArgs) => {
      if (includeErrors === true && errors) fun.if(condition, () => error(errorArgs))
      else fun.write('if (%s) return false', condition) // fast-track and inline for more readable code
    }

    const fail = (msg, value) => {
      const comment = value !== undefined ? ` ${JSON.stringify(value)}` : ''
      throw new Error(`${msg}${comment} at ${functions.toPointer(schemaPath)}`)
    }
    const enforce = (ok, ...args) => ok || fail(...args)
    const laxMode = (ok, ...args) => enforce(mode === 'lax' || ok, ...args)
    const enforceMinMax = (a, b) => laxMode(!(node[b] < node[a]), `Invalid ${a} / ${b} combination`)
    const enforceValidation = (msg) => enforce(!requireValidation, `[requireValidation] ${msg}`)
    const subPath = (...args) => [...schemaPath, ...args]

    // evaluated tracing
    const stat = initTracing()
    const evaluateDelta = (delta) => applyDelta(stat, delta)

    if (typeof node === 'boolean') {
      if (node === true) {
        // any is valid
        enforceValidation('schema = true is not allowed')
        return stat // nothing is evaluated for true
      } else if (definitelyPresent) {
        // node === false always fails in this case
        error({})
      } else {
        // node === false
        errorIf(present(current), {})
      }
      evaluateDelta({ properties: [true], items: Infinity }) // everything is evaluated for false
      return stat
    }

    enforce(node && Object.getPrototypeOf(node) === Object.prototype, 'Schema is not an object')
    for (const key of Object.keys(node))
      enforce(knownKeywords.includes(key) || allowUnusedKeywords, 'Keyword not supported:', key)

    if (Object.keys(node).length === 0) {
      enforceValidation('empty rules node encountered')
      return stat // nothing to validate here, basically the same as node === true
    }

    const unused = new Set(Object.keys(node))
    const consume = (prop, ...ruleTypes) => {
      enforce(unused.has(prop), 'Unexpected double consumption:', prop)
      enforce(functions.hasOwn(node, prop), 'Is not an own property:', prop)
      enforce(ruleTypes.every((t) => schemaTypes.has(t)), 'Invalid type used in consume')
      enforce(ruleTypes.some((t) => schemaTypes.get(t)(node[prop])), 'Type not expected:', prop)
      unused.delete(prop)
    }

    const finish = () => {
      if (!definitelyPresent) fun.write('}') // undefined check
      enforce(unused.size === 0 || allowUnusedKeywords, 'Unprocessed keywords:', [...unused])
    }

    if (node === root) {
      const $schema = node.$schema || $schemaDefault
      if (node.$schema) {
        if (typeof node.$schema !== 'string') throw new Error('Unexpected $schema')
        consume('$schema', 'string')
      }
      if ($schema) {
        const version = $schema.replace(/^http:\/\//, 'https://').replace(/#$/, '')
        enforce(schemaVersions.includes(version), 'Unexpected schema version:', version)
        const schemaIsOlderThan = (ver) =>
          schemaVersions.indexOf(version) >
          schemaVersions.indexOf(`https://json-schema.org/${ver}/schema`)
        rootMeta.set(root, {
          exclusiveRefs: schemaIsOlderThan('draft/2019-09'),
          booleanRequired: schemaIsOlderThan('draft-04'),
        })
      }
      if (node.$vocabulary) {
        for (const [vocab, flag] of Object.entries(node.$vocabulary)) {
          if (flag === false) continue
          enforce(flag === true && knownVocabularies.includes(vocab), 'Unknown vocabulary:', vocab)
        }
        consume('$vocabulary', 'object')
      }
    }

    if (node === schema && recursiveAnchor) consume('$recursiveAnchor', 'boolean')

    if (typeof node.description === 'string') consume('description', 'string') // unused, meta-only
    if (typeof node.title === 'string') consume('title', 'string') // unused, meta-only
    if (typeof node.$comment === 'string') consume('$comment', 'string') // unused, meta-only
    if (Array.isArray(node.examples)) consume('examples', 'array') // unused, meta-only

    // defining defs are allowed, those are validated on usage
    if (typeof node.$defs === 'object') {
      consume('$defs', 'object')
    } else if (typeof node.definitions === 'object') {
      consume('definitions', 'object')
    }

    const basePath = () => (basePathStack.length > 0 ? basePathStack[basePathStack.length - 1] : '')
    if (typeof node.$id === 'string') {
      basePathStack.push(joinPath(basePath(), node.$id))
      consume('$id', 'string')
    } else if (typeof node.id === 'string') {
      basePathStack.push(joinPath(basePath(), node.id))
      consume('id', 'string')
    }
    // $anchor is used only for ref resolution, on usage
    if (typeof node.$anchor === 'string') consume('$anchor', 'string')

    const booleanRequired = getMeta().booleanRequired && typeof node.required === 'boolean'
    if (node.default !== undefined && !useDefaults) consume('default', 'jsonval') // unused in this case
    const defaultIsPresent = node.default !== undefined && useDefaults // will consume on use
    if (definitelyPresent) {
      if (defaultIsPresent) fail('Can not apply default value here (e.g. at root)')
      if (node.required === true || node.required === false)
        fail('Can not apply boolean required here (e.g. at root)')
    } else if (defaultIsPresent || booleanRequired) {
      fun.write('if (%s) {', safenot(present(current)))
      if (defaultIsPresent) {
        fun.write('%s = %j', name, node.default)
        consume('default', 'jsonval')
      }
      if (booleanRequired) {
        if (node.required === true) {
          if (!defaultIsPresent) error({ path: ['required'] })
          consume('required', 'boolean')
        } else if (node.required === false) {
          consume('required', 'boolean')
        }
      }
      fun.write('} else {')
    } else {
      fun.write('if (%s) {', present(current))
    }

    const applyRef = (n, errorArgs) => {
      // Allow recursion to here only if $recursiveAnchor is true, else skip from deep recursion
      const recursive = recursiveAnchor ? format('recursive || validate') : format('recursive')
      if (includeErrors) {
        // Save and restore errors in case of recursion
        const res = gensym('res')
        const err = gensym('err')
        const suberr = gensym('suberr')
        fun.write('const %s = validate.errors', err)
        fun.write('const %s = %s(%s, %s)', res, n, name, recursive)
        fun.write('const %s = %s.errors', suberr, n)
        fun.write('validate.errors = %s', err)
        errorIf(safenot(res), { ...errorArgs, source: suberr })
      } else {
        errorIf(format('!%s(%s, %s)', n, name, recursive), errorArgs)
      }
      // evaluated: propagate static from ref to current, skips cyclic
      if (scope[n] && scope[n][evaluatedStatic]) evaluateDelta(scope[n][evaluatedStatic])
      else evaluateDelta({ unknown: true }) // assume unknown if ref is cyclic
    }
    if (node.$ref) {
      const resolved = resolveReference(root, schemas, node.$ref, basePath())
      const [sub, subRoot, path] = resolved[0] || []
      if (sub || sub === false) {
        let n = getref(sub)
        if (!n) n = compile(sub, subRoot, opts, scope, path)
        applyRef(n, { path: ['$ref'] })
      } else fail('failed to resolve $ref:', node.$ref)
      consume('$ref', 'string')

      if (getMeta().exclusiveRefs) {
        // ref overrides any sibling keywords for older schemas
        finish()
        return stat
      }
    }
    if (node.$recursiveRef) {
      enforce(node.$recursiveRef === '#', 'Behavior of $recursiveRef is defined only for "#"')
      // Apply deep recursion from here only if $recursiveAnchor is true, else just run self
      const n = recursiveAnchor ? format('(recursive || validate)') : format('validate')
      applyRef(n, { path: ['$recursiveRef'] })
      consume('$recursiveRef', 'string')
    }

    /* Preparation and methods, post-$ref validation will begin at the end of the function */

    const hasSubValidation =
      node.$ref || ['allOf', 'anyOf', 'oneOf'].some((key) => Array.isArray(node[key]))

    const typeArray =
      node.type === undefined ? null : Array.isArray(node.type) ? node.type : [node.type]
    for (const t of typeArray || [])
      enforce(typeof t === 'string' && types.has(t), 'Unknown type:', t)
    // typeArray === null means no type validation, which is required if we don't have const or enum
    if (typeArray === null && node.const === undefined && !node.enum && !hasSubValidation)
      enforceValidation('type is required')

    // This is used for typechecks, null means * here
    const allIn = (arr, valid) => {
      /* c8 ignore next */
      if (!Array.isArray(valid) || valid.length === 0) throw new Error('Unreachable')
      return arr && arr.every((s) => valid.includes(s)) // all arr entries are in valid
    }
    const someIn = (arr, possible) => {
      /* c8 ignore next */
      if (!Array.isArray(possible) || possible.length === 0) throw new Error('Unreachable')
      return arr === null || arr.some((x) => possible.includes(x)) // at least one arr entry is in possible
    }

    const parentCheckedType = (...valid) => queryCurrent().some((h) => allIn(h.typeArray, valid))
    const definitelyType = (...valid) => allIn(typeArray, valid) || parentCheckedType(...valid)
    const typeApplicable = (...possible) =>
      someIn(typeArray, possible) && queryCurrent().every((h) => someIn(h.typeArray, possible))

    const compare = (variableName, value) => {
      if (value && typeof value === 'object') {
        scope.deepEqual = functions.deepEqual
        return format('deepEqual(%s, %j)', variableName, value)
      }
      return format('%s === %j', variableName, value)
    }

    const enforceRegex = (source, target = node) => {
      enforce(typeof source === 'string', 'Invalid pattern:', source)
      if (requireValidation || requireStringValidation)
        enforce(/^\^.*\$$/.test(source), 'Should start with ^ and end with $:', source)
      if (complexityChecks && ((source.match(/[{+*]/g) || []).length > 1 || /\)[{+*]/.test(source)))
        enforce(target.maxLength !== undefined, 'maxLength should be specified for:', source)
    }

    const patternTest = (pat, key) => {
      // Convert common patterns to string checks, makes generated code easier to read (and a tiny perf bump)
      const r = pat.replace(/[.^$|*+?(){}[\]\\]/gu, '') // Special symbols: .^$|*+?(){}[]\
      if (pat === `^${r}$`) return format('(%s === %j)', key, pat.slice(1, -1)) // ^abc$ -> === abc
      if (noopRegExps.has(pat)) return format('true') // known noop

      // All of the below will cause warnings in enforced string validation mode, but let's make what they actually do more visible
      // note that /^.*$/u.test('\n') is false, so don't combine .* with anchors here!
      if ([r, `${r}+`, `${r}.*`, `.*${r}.*`].includes(pat)) return format('%s.includes(%j)', key, r)
      if ([`^${r}`, `^${r}+`, `^${r}.*`].includes(pat)) return format('%s.startsWith(%j)', key, r)
      if ([`${r}$`, `.*${r}$`].includes(pat)) return format('%s.endsWith(%j)', key, r)

      const subr = [...r].slice(0, -1).join('') // without the last symbol, astral plane aware
      if ([`${r}*`, `${r}?`].includes(pat))
        return subr.length === 0 ? format('true') : format('%s.includes(%j)', key, subr) // abc*, abc? -> includes(ab)
      if ([`^${r}*`, `^${r}?`].includes(pat))
        return subr.length === 0 ? format('true') : format('%s.startsWith(%j)', key, subr) // ^abc*, ^abc? -> startsWith(ab)

      // A normal reg-exp test
      return format('%s.test(%s)', genpattern(pat), key)
    }

    const maybeWrap = (shouldWrap, fmt, args, close, writeBody) => {
      if (!shouldWrap) return writeBody()
      fun.block(fmt, args, close, writeBody)
    }

    const forObjectKeys = (key, obj, writeBody) => {
      fun.block('for (const %s of Object.keys(%s)) {', [key, obj], '}', () => {
        writeBody(currPropVar(key, true)) // always own property here
      })
    }

    // Those checks will need to be skipped if another error is set in this block before those ones
    const prev =
      allErrors && (node.uniqueItems || node.pattern || node.patternProperties || node.format)
        ? gensym('prev')
        : null
    const prevWrap = (shouldWrap, writeBody) =>
      maybeWrap(prev !== null && shouldWrap, 'if (errorCount === %s) {', [prev], '}', writeBody)

    // Can not be used before undefined check above! The one performed by present()
    const rule = (...args) =>
      visit(errors, [...history, { stat, prop: current, typeArray }], ...args)
    const subrule = (suberr, ...args) => {
      const sub = gensym('sub')
      fun.write('const %s = (() => {', sub)
      if (allErrors) fun.write('let errorCount = 0') // scoped error counter
      const delta = visit(suberr, [...history, { stat, prop: current, typeArray }], ...args)
      if (allErrors) {
        fun.write('return errorCount === 0')
      } else fun.write('return true')
      fun.write('})()')
      return { sub, delta }
    }

    const suberror = () => {
      const suberr = includeErrors && allErrors ? gensym('suberr') : null
      if (suberr) fun.write('let %s = null', suberr)
      return suberr
    }
    const mergeerror = (suberr) => {
      if (!suberr) return
      // suberror can be null e.g. on failed empty contains
      const args = [errors, suberr, errors, suberr, suberr, errors, suberr]
      fun.write('if (%s && %s) { %s.push(...%s) } else if (%s) %s = %s', ...args)
    }

    // Extracted single additional(Items/Properties) rules, for reuse with unevaluated(Items/Properties)
    const additionalItems = (limit, ruleValue, rulePath) => {
      if (ruleValue === false) {
        if (removeAdditional) {
          fun.write('if (%s.length > %s) %s.length = %s', name, limit, name, limit)
        } else {
          errorIf(format('%s.length > %s', name, limit), { path: [rulePath] })
        }
      } else if (ruleValue) {
        const i = genloop()
        fun.block('for (let %s = %s; %s < %s.length; %s++) {', [i, limit, i, name, i], '}', () => {
          const prop = currPropVar(i, unmodifiedPrototypes, true) // own property in Array if proto not mangled
          rule(prop, ruleValue, subPath(rulePath))
        })
      }
      consume(rulePath, 'object', 'boolean')
      evaluateDelta({ items: Infinity })
    }
    const additionalProperties = (condition, ruleValue, rulePath) => {
      const key = gensym('key')
      forObjectKeys(key, name, (sub) => {
        fun.if(condition(key), () => {
          if (ruleValue === false && removeAdditional) fun.write('delete %s[%s]', name, key)
          else rule(sub, ruleValue, subPath(rulePath))
        })
      })
      consume(rulePath, 'object', 'boolean')
      evaluateDelta({ properties: [true] })
    }
    const additionalCondition = (key, properties, patternProperties) =>
      safeand(
        ...[...new Set(properties)].map((p) => format('%s !== %j', key, p)),
        ...[...new Set(patternProperties)].map((p) => safenot(patternTest(p, key)))
      )

    /* Checks inside blocks are independent, they are happening on the same code depth */

    const checkNumbers = () => {
      const applyMinMax = (value, operator, errorArgs) => {
        enforce(Number.isFinite(value), 'Invalid minimum or maximum:', value)
        errorIf(format('!(%d %c %s)', value, operator, name), errorArgs)
      }

      if (Number.isFinite(node.exclusiveMinimum)) {
        applyMinMax(node.exclusiveMinimum, '<', { path: ['exclusiveMinimum'] })
        consume('exclusiveMinimum', 'finite')
      } else if (node.minimum !== undefined) {
        applyMinMax(node.minimum, node.exclusiveMinimum ? '<' : '<=', { path: ['minimum'] })
        consume('minimum', 'finite')
        if (typeof node.exclusiveMinimum === 'boolean') consume('exclusiveMinimum', 'boolean')
      }

      if (Number.isFinite(node.exclusiveMaximum)) {
        applyMinMax(node.exclusiveMaximum, '>', { path: ['exclusiveMaximum'] })
        enforceMinMax('minimum', 'exclusiveMaximum')
        enforceMinMax('exclusiveMinimum', 'exclusiveMaximum')
        consume('exclusiveMaximum', 'finite')
      } else if (node.maximum !== undefined) {
        applyMinMax(node.maximum, node.exclusiveMaximum ? '>' : '>=', { path: ['maximum'] })
        enforceMinMax('minimum', 'maximum')
        enforceMinMax('exclusiveMinimum', 'maximum')
        consume('maximum', 'finite')
        if (typeof node.exclusiveMaximum === 'boolean') consume('exclusiveMaximum', 'boolean')
      }

      const multipleOf = node.multipleOf === undefined ? 'divisibleBy' : 'multipleOf' // draft3 support
      if (node[multipleOf] !== undefined) {
        const value = node[multipleOf]
        enforce(Number.isFinite(value) && value > 0, `Invalid ${multipleOf}:`, value)
        if (Number.isInteger(value)) {
          errorIf(format('%s %% %d !== 0', name, value), { path: ['isMultipleOf'] })
        } else {
          scope.isMultipleOf = functions.isMultipleOf
          const [last, exp] = `${value}`.replace(/.*\./, '').split('e-')
          const e = last.length + (exp ? Number(exp) : 0)
          const args = [name, value, e, Math.round(value * Math.pow(10, e))] // precompute for performance
          errorIf(format('!isMultipleOf(%s, %d, 1e%d, %d)', ...args), { path: ['isMultipleOf'] })
        }
        consume(multipleOf, 'finite')
      }
    }

    const checkStrings = () => {
      if (node.maxLength !== undefined) {
        enforce(Number.isFinite(node.maxLength), 'Invalid maxLength:', node.maxLength)
        scope.stringLength = functions.stringLength
        const args = [name, node.maxLength, name, node.maxLength]
        errorIf(format('%s.length > %d && stringLength(%s) > %d', ...args), { path: ['maxLength'] })
        consume('maxLength', 'natural')
      }

      if (node.minLength !== undefined) {
        enforce(Number.isFinite(node.minLength), 'Invalid minLength:', node.minLength)
        enforceMinMax('minLength', 'maxLength')
        scope.stringLength = functions.stringLength
        const args = [name, node.minLength, name, node.minLength]
        errorIf(format('%s.length < %d || stringLength(%s) < %d', ...args), { path: ['minLength'] })
        consume('minLength', 'natural')
      }

      prevWrap(true, () => {
        const checkFormat = (fmtname, target, path, formatsObj = fmts) => {
          const known = typeof fmtname === 'string' && functions.hasOwn(formatsObj, fmtname)
          enforce(known, 'Unrecognized format used:', fmtname)
          const formatImpl = formatsObj[fmtname]
          const valid = formatImpl instanceof RegExp || typeof formatImpl === 'function'
          enforce(valid, 'Invalid format used:', fmtname)
          const n = genformat(formatImpl)
          if (formatImpl instanceof RegExp) {
            // built-in formats are fine, check only ones from options
            if (functions.hasOwn(optFormats, fmtname)) enforceRegex(formatImpl.source)
            errorIf(format('!%s.test(%s)', n, target), { path: [path] })
          } else {
            errorIf(format('!%s(%s)', n, target), { path: [path] })
          }
        }
        if (node.format) {
          checkFormat(node.format, name, 'format')
          consume('format', 'string')
        }

        if (node.pattern) {
          enforceRegex(node.pattern)
          if (!noopRegExps.has(node.pattern))
            errorIf(safenot(patternTest(node.pattern, name)), { path: ['pattern'] })
          consume('pattern', 'string')
        }

        enforce(node.contentSchema !== false, 'contentSchema cannot be set to false')
        if (node.contentEncoding || node.contentMediaType || node.contentSchema) {
          const dec = gensym('dec')
          if (node.contentMediaType) fun.write('let %s = %s', dec, name)

          if (node.contentEncoding === 'base64') {
            checkFormat('base64', name, 'contentEncoding', formats.extra)
            if (node.contentMediaType) {
              scope.deBase64 = functions.deBase64
              fun.write('try {')
              fun.write('%s = deBase64(%s)', dec, dec)
            }
            consume('contentEncoding', 'string')
          } else enforce(!node.contentEncoding, 'Unknown contentEncoding:', node.contentEncoding)

          let json = false
          if (node.contentMediaType === 'application/json') {
            fun.write('try {')
            fun.write('%s = JSON.parse(%s)', dec, dec)
            json = true
            consume('contentMediaType', 'string')
          } else enforce(!node.contentMediaType, 'Unknown contentMediaType:', node.contentMediaType)

          if (node.contentSchema) {
            enforce(json, 'contentSchema requires contentMediaType application/json')
            const decprop = Object.freeze({ name: dec, errorParent: current })
            rule(decprop, node.contentSchema, subPath('contentSchema')) // TODO: isJSON true for speed?
            consume('contentSchema', 'object', 'array')
          }
          if (node.contentMediaType) {
            fun.write('} catch (e) {')
            error({ path: ['contentMediaType'] })
            fun.write('}')
            if (node.contentEncoding) {
              fun.write('} catch (e) {')
              error({ path: ['contentEncoding'] })
              fun.write('}')
            }
          }
        }
      })

      const stringValidated = node.format || node.pattern || node.contentSchema || hasSubValidation
      const stringWarning = 'pattern, format or contentSchema must be specified for strings'
      if (typeApplicable('string') && requireStringValidation && !stringValidated)
        fail(`[requireStringValidation] ${stringWarning}, use pattern: ^[\\s\\S]*$ to opt-out`)
    }

    const checkArrays = () => {
      if (node.maxItems !== undefined) {
        enforce(Number.isFinite(node.maxItems), 'Invalid maxItems:', node.maxItems)
        if (Array.isArray(node.items) && node.items.length > node.maxItems)
          fail(`Invalid maxItems: ${node.maxItems} is less than items array length`)
        errorIf(format('%s.length > %d', name, node.maxItems), { path: ['maxItems'] })
        consume('maxItems', 'natural')
      }

      if (node.minItems !== undefined) {
        enforce(Number.isFinite(node.minItems), 'Invalid minItems:', node.minItems)
        enforceMinMax('minItems', 'maxItems')
        // can be higher that .items length with additionalItems
        errorIf(format('%s.length < %d', name, node.minItems), { path: ['minItems'] })
        consume('minItems', 'natural')
      }

      if (node.items || node.items === false) {
        if (Array.isArray(node.items)) {
          for (let p = 0; p < node.items.length; p++)
            rule(currPropImm(p), node.items[p], subPath(`${p}`))
          evaluateDelta({ items: node.items.length })
        } else {
          const i = genloop()
          fun.block('for (let %s = 0; %s < %s.length; %s++) {', [i, i, name, i], '}', () => {
            const prop = currPropVar(i, unmodifiedPrototypes, true) // own property in Array if proto not mangled
            rule(prop, node.items, subPath('items'))
          })
          stat.items = Infinity
        }
        consume('items', 'object', 'array', 'boolean')
      } else if (typeApplicable('array') && !hasSubValidation) {
        enforceValidation('items rule must be specified')
      }

      if (!Array.isArray(node.items)) {
        // additionalItems is allowed, but ignored per some spec tests in this case!
        // We do nothing and let it throw except for in allowUnusedKeywords mode
        // As a result, this is not allowed by default, only in allowUnusedKeywords mode
      } else if (node.additionalItems || node.additionalItems === false) {
        additionalItems(format('%d', node.items.length), node.additionalItems, 'additionalItems')
      } else if (node.items.length === node.maxItems) {
        // No additional items are possible
      } else {
        enforceValidation('additionalItems rule must be specified for fixed arrays')
      }

      if (node.contains || node.contains === false) {
        const passes = gensym('passes')
        fun.write('let %s = 0', passes)

        const suberr = suberror()
        const i = genloop()
        fun.block('for (let %s = 0; %s < %s.length; %s++) {', [i, i, name, i], '}', () => {
          const prop = currPropVar(i, unmodifiedPrototypes, true) // own property in Array if proto not mangled
          const { sub } = subrule(suberr, prop, node.contains, subPath('contains'))
          fun.write('if (%s) %s++', sub, passes)
          // evaluateDelta({ unknown: true }) // draft2020: contains counts towards evaluatedItems
        })

        if (Number.isFinite(node.minContains)) {
          const condition = format('%s < %d', passes, node.minContains) // fast, reusable
          errorIf(condition, { path: ['minContains'] })
          consume('minContains', 'natural')
          fun.if(condition, () => mergeerror(suberr))
        } else {
          const condition = format('%s < 1', passes) // fast, reusable
          errorIf(condition, { path: ['contains'] })
          fun.if(condition, () => mergeerror(suberr))
        }

        if (Number.isFinite(node.maxContains)) {
          errorIf(format('%s > %d', passes, node.maxContains), { path: ['maxContains'] })
          enforceMinMax('minContains', 'maxContains')
          consume('maxContains', 'natural')
        }

        consume('contains', 'object', 'boolean')
      }

      const uniqueIsSimple = () => {
        if (node.maxItems !== undefined) return true
        if (typeof node.items === 'object') {
          if (Array.isArray(node.items) && node.additionalItems === false) return true
          if (!Array.isArray(node.items) && node.items.type) {
            const itemTypes = Array.isArray(node.items.type) ? node.items.type : [node.items.type]
            const primitiveTypes = ['null', 'boolean', 'number', 'integer', 'string']
            if (itemTypes.every((itemType) => primitiveTypes.includes(itemType))) return true
          }
        }
        return false
      }
      prevWrap(true, () => {
        if (node.uniqueItems === true) {
          if (complexityChecks)
            enforce(uniqueIsSimple(), 'maxItems should be specified for non-primitive uniqueItems')
          scope.unique = functions.unique
          scope.deepEqual = functions.deepEqual
          errorIf(format('!unique(%s)', name), { path: ['uniqueItems'] })
          consume('uniqueItems', 'boolean')
        } else if (node.uniqueItems === false) {
          consume('uniqueItems', 'boolean')
        }
      })
    }

    const checkObjects = () => {
      const propertiesCount = format('Object.keys(%s).length', name)
      if (node.maxProperties !== undefined) {
        enforce(Number.isFinite(node.maxProperties), 'Invalid maxProperties:', node.maxProperties)
        errorIf(format('%s > %d', propertiesCount, node.maxProperties), { path: ['maxProperties'] })
        consume('maxProperties', 'natural')
      }
      if (node.minProperties !== undefined) {
        enforce(Number.isFinite(node.minProperties), 'Invalid minProperties:', node.minProperties)
        enforceMinMax('minProperties', 'maxProperties')
        errorIf(format('%s < %d', propertiesCount, node.minProperties), { path: ['minProperties'] })
        consume('minProperties', 'natural')
      }

      if (typeof node.propertyNames === 'object' || typeof node.propertyNames === 'boolean') {
        const key = gensym('key')
        forObjectKeys(key, name, (sub) => {
          const names = node.propertyNames
          const nameSchema = typeof names === 'object' ? { type: 'string', ...names } : names
          const nameprop = Object.freeze({ name: key, errorParent: sub, type: 'string' })
          rule(nameprop, nameSchema, subPath('propertyNames'))
        })
        consume('propertyNames', 'object', 'boolean')
      }
      if (typeof node.additionalProperties === 'object' && typeof node.propertyNames !== 'object')
        enforceValidation('wild-card additionalProperties requires propertyNames')

      // if allErrors is false, we can skip present check for required properties validated before
      const checked = (p) =>
        !allErrors &&
        (stat.required.includes(p) || queryCurrent().some((h) => h.stat.required.includes(p)))

      if (Array.isArray(node.required)) {
        for (const req of node.required) {
          if (checked(req)) continue
          const prop = currPropImm(req)
          errorIf(safenot(present(prop)), { path: ['required'], prop })
        }
        evaluateDelta({ required: node.required })
        consume('required', 'array')
      }

      for (const dependencies of ['dependencies', 'dependentRequired', 'dependentSchemas']) {
        if (node[dependencies]) {
          for (const key of Object.keys(node[dependencies])) {
            let deps = node[dependencies][key]
            if (typeof deps === 'string') deps = [deps]
            const item = currPropImm(key, checked(key))
            if (Array.isArray(deps) && dependencies !== 'dependentSchemas') {
              const clauses = deps.filter((k) => !checked(k)).map((k) => present(currPropImm(k)))
              const condition = safenot(safeand(...clauses))
              const errorArgs = { path: [dependencies, key] }
              if (clauses.length === 0) {
                // nothing to do
              } else if (item.checked) {
                errorIf(condition, errorArgs)
                evaluateDelta({ required: deps })
              } else {
                errorIf(safeand(present(item), condition), errorArgs)
              }
            } else if (
              ((typeof deps === 'object' && !Array.isArray(deps)) || typeof deps === 'boolean') &&
              dependencies !== 'dependentRequired'
            ) {
              const body = () => {
                const delta = rule(current, deps, subPath(dependencies, key))
                evaluateDelta(orDelta({}, delta))
              }
              if (item.checked) body()
              else fun.if(present(item), body)
            } else fail(`Unexpected ${dependencies} entry`)
          }
          consume(dependencies, 'object')
        }
      }

      if (typeof node.properties === 'object') {
        for (const p of Object.keys(node.properties))
          rule(currPropImm(p, checked(p)), node.properties[p], subPath('properties', p))
        evaluateDelta({ properties: Object.keys(node.properties || {}) })
        consume('properties', 'object')
      }

      prevWrap(node.patternProperties, () => {
        if (node.patternProperties) {
          const key = gensym('key')
          forObjectKeys(key, name, (sub) => {
            for (const p of Object.keys(node.patternProperties)) {
              enforceRegex(p, node.propertyNames || {})
              fun.if(patternTest(p, key), () => {
                rule(sub, node.patternProperties[p], subPath('patternProperties', p))
              })
            }
          })
          evaluateDelta({ patterns: Object.keys(node.patternProperties || {}) })
          consume('patternProperties', 'object')
        }
        if (node.additionalProperties || node.additionalProperties === false) {
          const properties = Object.keys(node.properties || {})
          const patternProperties = Object.keys(node.patternProperties || {})
          const condition = (key) => additionalCondition(key, properties, patternProperties)
          additionalProperties(condition, node.additionalProperties, 'additionalProperties')
        } else if (typeApplicable('object') && !hasSubValidation) {
          enforceValidation('additionalProperties rule must be specified')
        }
      })
    }

    const checkConst = () => {
      if (node.const !== undefined) {
        errorIf(safenot(compare(name, node.const)), { path: ['const'] })
        consume('const', 'jsonval')
        return true
      } else if (node.enum) {
        enforce(Array.isArray(node.enum), 'Invalid enum')
        const objects = node.enum.filter((value) => value && typeof value === 'object')
        const primitive = node.enum.filter((value) => !(value && typeof value === 'object'))
        const condition = safeor(...[...primitive, ...objects].map((value) => compare(name, value)))
        errorIf(safenot(condition), { path: ['enum'] })
        consume('enum', 'array')
        return true
      }
      return false
    }

    const checkGeneric = () => {
      if (node.not || node.not === false) {
        const { sub } = subrule(null, current, node.not, subPath('not'))
        errorIf(sub, { path: ['not'] })
        consume('not', 'object', 'boolean')
      }

      const thenOrElse = node.then || node.then === false || node.else || node.else === false
      if ((node.if || node.if === false) && thenOrElse) {
        const { sub, delta: deltaIf } = subrule(null, current, node.if, subPath('if'))
        let deltaElse, deltaThen
        fun.write('if (%s) {', safenot(sub))
        if (node.else || node.else === false) {
          deltaElse = rule(current, node.else, subPath('else'))
          consume('else', 'object', 'boolean')
        } else deltaElse = {}
        if (node.then || node.then === false) {
          fun.write('} else {')
          deltaThen = rule(current, node.then, subPath('then'))
          consume('then', 'object', 'boolean')
        } else deltaThen = {}
        fun.write('}')
        evaluateDelta(orDelta(deltaElse, andDelta(deltaIf, deltaThen)))
        consume('if', 'object', 'boolean')
      }

      if (node.allOf !== undefined) {
        enforce(Array.isArray(node.allOf), 'Invalid allOf')
        for (const [key, sch] of Object.entries(node.allOf))
          evaluateDelta(rule(current, sch, subPath('allOf', key)))
        consume('allOf', 'array')
      }

      if (node.anyOf !== undefined) {
        enforce(Array.isArray(node.anyOf), 'Invalid anyOf')
        const suberr = suberror()
        let delta
        for (const [key, sch] of Object.entries(node.anyOf)) {
          const { sub, delta: deltaVariant } = subrule(suberr, current, sch, subPath('anyOf', key))
          fun.write('if (%s) {', safenot(sub))
          delta = delta ? orDelta(delta, deltaVariant) : deltaVariant
        }
        if (node.anyOf.length > 0) evaluateDelta(delta)
        error({ path: ['anyOf'] })
        mergeerror(suberr)
        node.anyOf.forEach(() => fun.write('}'))
        consume('anyOf', 'array')
      }

      if (node.oneOf !== undefined) {
        enforce(Array.isArray(node.oneOf), 'Invalid oneOf')
        const passes = gensym('passes')
        fun.write('let %s = 0', passes)
        const suberr = suberror()
        let delta
        let i = 0
        for (const [key, sch] of Object.entries(node.oneOf)) {
          const { sub, delta: deltaVariant } = subrule(suberr, current, sch, subPath('oneOf', key))
          fun.write('if (%s) %s++', sub, passes)
          if (!includeErrors && i++ > 0) errorIf(format('%s > 1', passes), { path: ['oneOf'] })
          delta = delta ? orDelta(delta, deltaVariant) : deltaVariant
        }
        if (node.oneOf.length > 0) evaluateDelta(delta)
        errorIf(format('%s !== 1', passes), { path: ['oneOf'] })
        fun.if(format('%s === 0', passes), () => mergeerror(suberr)) // if none matched, dump all errors
        consume('oneOf', 'array')
      }
    }

    const typeWrap = (checkBlock, validTypes, queryType) => {
      const [funSize, unusedSize] = [fun.size(), unused.size]
      maybeWrap(!definitelyType(...validTypes), 'if (%s) {', [queryType], '}', checkBlock)
      // enforce check that non-applicable blocks are empty and no rules were applied
      if (funSize !== fun.size() || unusedSize !== unused.size)
        enforce(typeApplicable(...validTypes), `Unexpected rules in type`, node.type)
    }

    // Unevaluated validation
    const checkArraysFinal = () => {
      if (stat.items === Infinity) {
        // Everything is statically evaluated, so this check is unreachable. Allow only 'false' rule here.
        if (node.unevaluatedItems === false) consume('unevaluatedItems', 'boolean')
      } else if (node.unevaluatedItems || node.unevaluatedItems === false) {
        if (isDynamic(stat).items) throw new Error('Dynamic unevaluated is not implemented')
        const limit = format('%d', stat.items)
        additionalItems(limit, node.unevaluatedItems, 'unevaluatedItems')
      }
    }
    const checkObjectsFinal = () => {
      prevWrap(node.patternProperties, () => {
        if (stat.properties.includes(true)) {
          // Everything is statically evaluated, so this check is unreachable. Allow only 'false' rule here.
          if (node.unevaluatedProperties === false) consume('unevaluatedProperties', 'boolean')
        } else if (node.unevaluatedProperties || node.unevaluatedProperties === false) {
          if (isDynamic(stat).properties) throw new Error('Dynamic unevaluated is not implemented')
          const sawStatic = (key) => additionalCondition(key, stat.properties, stat.patterns)
          additionalProperties(sawStatic, node.unevaluatedProperties, 'unevaluatedProperties')
        }
      })
    }

    /* Actual post-$ref validation happens here */

    const typeExact = (type) => typeArray && typeArray.length === 1 && typeArray[0] === type
    if (current.type)
      enforce(typeExact(current.type), 'Only one type is allowed here:', current.type)
    const needTypeValidate = !current.type && typeArray !== null && !parentCheckedType(...typeArray)
    if (needTypeValidate) {
      const filteredTypes = typeArray.filter((t) => typeApplicable(t))
      if (filteredTypes.length === 0) fail('No valid types possible')
      const typeInvalid = safenot(safeor(...filteredTypes.map((t) => types.get(t)(name))))
      errorIf(typeInvalid, { path: ['type'] })
    }
    if (node.type !== undefined) consume('type', 'string', 'array')

    // If type validation was needed and did not return early, wrap this inside an else clause.
    maybeWrap(needTypeValidate && allErrors, 'else {', [], '}', () => {
      if (prev !== null) fun.write('let %s = errorCount', prev)
      if (checkConst()) {
        // const/enum shouldn't have any other validation rules except for already checked type/$ref
        enforce(unused.size === 0, 'Unexpected keywords mixed with const or enum:', [...unused])
        evaluateDelta({ properties: [true], items: Infinity }) // everything is evaluated for const
        return
      }

      typeWrap(checkNumbers, ['number', 'integer'], types.get('number')(name))
      typeWrap(checkStrings, ['string'], types.get('string')(name))
      typeWrap(checkArrays, ['array'], types.get('array')(name))
      typeWrap(checkObjects, ['object'], types.get('object')(name))
      checkGeneric()

      typeWrap(checkArraysFinal, ['array'], types.get('array')(name))
      typeWrap(checkObjectsFinal, ['object'], types.get('object')(name))
    })

    finish()
    return stat // return statically evaluated
  }

  const stat = visit(format('validate.errors'), [], { name: safe('data') }, schema, [])

  if (allErrors) {
    fun.write('return errorCount === 0')
  } else fun.write('return true')
  fun.write('}')

  if (dryRun) return

  validate = fun.makeFunction(scope)
  validate[evaluatedStatic] = stat
  delete scope[funname] // more logical key order
  scope[funname] = validate
  return funname
}

module.exports = { compile }
