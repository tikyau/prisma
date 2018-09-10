import {
  QueryMap,
  BindingOptions,
  SubscriptionMap /*, Operation*/,
  QueryOrMutation,
} from './types'
import {
  GraphQLObjectType,
  GraphQLScalarType,
  Kind,
  OperationTypeNode,
  print,
  execute,
  subscribe,
  GraphQLField,
} from 'graphql'
import mapAsyncIterator from './utils/mapAsyncIterator'
import { Delegate } from './Delegate'
import { mapValues } from './utils/mapValues'
import gql from 'graphql-tag'
const log = require('debug')('binding')
// to make the TS compiler happy

// to avoid recreation on each instantiation for the same schema, we cache the created methods
const delegateCache = new Map()

let instructionId = 0

export interface InstructionsMap {
  [key: string]: Instruction[]
}

export interface Instruction {
  fieldName: string
  args?: any
  field: GraphQLField<any, any>
  fragment: string | object
  typeName: string
}

export class Binding extends Delegate {
  // subscription: SubscriptionMap
  types: any
  query: any
  $subscribe: any
  debug
  mutation: any
  currentInstructions: InstructionsMap = {}

  constructor({ schema, fragmentReplacements, before, debug }: BindingOptions) {
    super({ schema, fragmentReplacements, before })
    this.debug = debug

    this.buildMethods()
  }

  buildQueryMethods(operation: QueryOrMutation): QueryMap {
    const queryType =
      operation === 'query'
        ? this.schema.getQueryType()
        : this.schema.getMutationType()
    if (!queryType) {
      return {}
    }
    const fields = queryType.getFields()
    return Object.entries(fields)
      .map(([fieldName, field]) => {
        return {
          key: fieldName,
          value: (args, info, options) => {
            return this.$delegate(operation, fieldName, args, info, options)
          },
        }
      })
      .reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {})
  }

  buildSubscriptionMethods(): SubscriptionMap {
    const subscriptionType = this.schema.getSubscriptionType()
    if (!subscriptionType) {
      return {}
    }
    const fields = subscriptionType.getFields()
    return Object.entries(fields)
      .map(([fieldName, field]) => {
        return {
          key: fieldName,
          value: (args, info, options) => {
            return this.delegateSubscription(fieldName, args, info, options)
          },
        }
      })
      .reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {})
  }

  getOperation(instructions) {
    return instructions[0].typeName.toLowerCase()
  }

  processInstructions = async (id: number): Promise<any> => {
    log('process instructions')
    const instructions = this.currentInstructions[id]

    const { ast, variables } = this.generateSelections(instructions)
    log('generated selections')
    const { variableDefinitions, ...restAst } = ast
    const operation = this.getOperation(instructions) as OperationTypeNode

    const document = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation,
          directives: [],
          variableDefinitions,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [restAst],
          },
        },
      ],
    }
    this.before()
    if (this.debug) {
      console.log(`\nQuery:`)
      const query = print(document)
      console.log(query)
      if (variables && Object.keys(variables).length > 0) {
        console.log('Variables:')
        console.log(JSON.stringify(variables))
      }
    }

    log('printed / before')
    const result = await this.execute(operation, document, variables)
    log('executed')

    if (operation === 'subscription') {
      return this.mapSubscriptionPayload(result, instructions)
    }

    return this.extractPayload(result, instructions)
  }

  mapSubscriptionPayload(result, instructions) {
    debugger
    return mapAsyncIterator(result, res =>
      this.extractPayload(res, instructions),
    )
  }

  extractPayload(result, instructions) {
    let pointer = result.data
    let count = 0
    while (
      pointer &&
      typeof pointer === 'object' &&
      !Array.isArray(pointer) &&
      count < instructions.length
    ) {
      pointer = pointer[Object.keys(pointer)[0]]
      count++
    }
    log('unpack it')

    return pointer
  }

  execute(operation, document, variables) {
    if (operation === 'subscription') {
      return subscribe(this.schema, document, {}, {}, variables)
    }
    return execute(this.schema, document, {}, {}, variables) as any
  }

  then = async (id, resolve, reject) => {
    let result
    try {
      // const before = Date.now()
      result = await this.processInstructions(id)
      // console.log(`then: ${Date.now() - before}`)
      this.currentInstructions[id] = []
      resolve(result)
    } catch (e) {
      this.currentInstructions[id] = []
      reject(e)
    }
    return result
  }

  catch = async (id, reject) => {
    try {
      await this.processInstructions(id)
    } catch (e) {
      this.currentInstructions[id] = []
      reject(e)
    }
  }

  generateSelections(instructions) {
    const variableDefinitions: any[] = []
    const variables = {}
    let variableCounter = {}

    const ast = instructions.reduceRight((acc, instruction, index) => {
      let args: any[] = []

      if (instruction.args && Object.keys(instruction.args).length > 0) {
        Object.entries(instruction.args).forEach(([name, value]) => {
          let variableName
          if (typeof variableCounter[name] === 'undefined') {
            variableName = name
            variableCounter[name] = 0
          } else {
            variableCounter[name]++
            variableName = `${name}_${variableCounter[name]}`
          }
          variables[variableName] = value
          const inputArg = instruction.field.args.find(arg => arg.name === name)
          if (!inputArg) {
            throw new Error(
              `Could not find argument ${name} for type ${this.getTypeName(
                instruction.field.type,
              )}`,
            )
          }

          variableDefinitions.push({
            kind: Kind.VARIABLE_DEFINITION,
            variable: {
              kind: Kind.VARIABLE,
              name: {
                kind: Kind.NAME,
                value: variableName,
              },
            },
            type: inputArg.astNode.type,
          })

          args.push({
            kind: Kind.ARGUMENT,
            name: {
              kind: Kind.NAME,
              value: name,
            },
            value: {
              kind: Kind.VARIABLE,
              name: {
                kind: 'Name',
                value: variableName,
              },
            },
          })
        })
      }

      const node = {
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: instruction.fieldName,
        },
        arguments: args,
        directives: [],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [] as any[],
        },
      }

      const type = this.getDeepType(instruction.field.type)
      if (
        index === instructions.length - 1 &&
        type instanceof GraphQLObjectType
      ) {
        if (instruction.fragment) {
          if (typeof instruction.fragment === 'string') {
            instruction.fragment = gql`
              ${instruction.fragment}
            `
          }
          node.selectionSet = instruction.fragment.definitions[0].selectionSet
        } else {
          node.selectionSet.selections = Object.entries(type.getFields())
            .filter(([_, field]: any) => {
              const fieldType = this.getDeepType(field.type)
              return fieldType instanceof GraphQLScalarType
            })
            .map(([fieldName]) => ({
              kind: Kind.FIELD,
              name: {
                kind: Kind.NAME,
                value: fieldName,
              },
              arguments: [],
              directives: [],
            }))
        }
      }

      if (acc) {
        node.selectionSet.selections.push(acc)
      }

      return node
    }, null)

    return {
      ast: { ...ast, variableDefinitions },
      variables,
    }
  }

  buildMethods() {
    this.buildDelegateMethods()
    this.buildORMMethods()
  }

  buildDelegateMethods() {
    const methods = this.getDelegateMethods()
    Object.assign(this.$delegate, methods)
  }

  getDelegateMethods() {
    const cachedMethods = delegateCache.get(this.schema)
    if (cachedMethods) {
      return cachedMethods
    }
    const methods = {
      query: this.buildQueryMethods('query'),
      mutation: this.buildQueryMethods('mutation'),
      subscription: this.buildSubscriptionMethods(),
    }
    delegateCache.set(this.schema, methods)
    return methods
  }

  buildORMMethods() {
    this.types = this.getORMTypes()
    Object.assign(this, this.types.Query)
    Object.assign(this, this.types.Mutation)
    this.$subscribe = this.types.Subscription
  }

  getORMTypes() {
    const typeMap = this.schema.getTypeMap()
    const types = Object.entries(typeMap)
      .map(([name, type]) => {
        let value = {
          then: this.then,
          catch: this.catch,
          [Symbol.toStringTag]: 'Promise',
        }
        if (type instanceof GraphQLObjectType) {
          value = {
            ...value,
            ...Object.entries(type.getFields())
              .map(([fieldName, field]) => {
                return {
                  key: fieldName,
                  value: (args, arg2, fragment) => {
                    const id = typeof args === 'number' ? args : ++instructionId

                    let realArgs = typeof args === 'number' ? arg2 : args
                    this.currentInstructions[id] =
                      this.currentInstructions[id] || []
                    if (this.currentInstructions[id].length === 0) {
                      if (name === 'Mutation') {
                        if (fieldName.startsWith('create')) {
                          realArgs = { data: realArgs }
                        }
                        if (fieldName.startsWith('delete')) {
                          realArgs = { where: realArgs }
                        }
                      } else if (name === 'Query') {
                        if (field.args.length === 1) {
                          realArgs = { where: realArgs }
                        }
                      }
                    }
                    this.currentInstructions[id].push({
                      fieldName,
                      args: realArgs,
                      field,
                      typeName: type.name,
                      fragment: typeof args === 'number' ? fragment : arg2,
                    })
                    const typeName = this.getTypeName(field.type)

                    // this is black magic. what we do here: bind both .then, .catch and all resolvers to `id`
                    return mapValues(this.types[typeName], (key, value) => {
                      if (typeof value === 'function') {
                        return value.bind(this, id)
                      }
                      return value
                    })
                  },
                }
              })
              .reduce(reduceKeyValue, {}),
          }
        }

        return {
          key: name,
          value,
        }
      })
      .reduce(reduceKeyValue, {})

    return types
  }

  getTypeName(type): string {
    if (type.ofType) {
      return this.getDeepType(type.ofType)
    }
    return type.name
  }

  getDeepType(type) {
    if (type.ofType) {
      return this.getDeepType(type.ofType)
    }

    return type
  }
}

const reduceKeyValue = (acc, curr) => ({
  ...acc,
  [curr.key]: curr.value,
})