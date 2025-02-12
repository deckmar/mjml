import {
  find,
  get,
  identity,
  map,
  omit,
  reduce,
  isObject,
  each,
  isEmpty,
} from 'lodash'
import path from 'path'
import juice from 'juice'
import cheerio from 'cheerio'

import MJMLParser from 'mjml-parser-xml'
import MJMLValidator, {
  dependencies as globalDependencies,
  assignDependencies,
} from 'mjml-validator'

import { initComponent } from './createComponent'
import globalComponents, {
  registerComponent,
  assignComponents,
} from './components'

import suffixCssClasses from './helpers/suffixCssClasses'
import mergeOutlookConditionnals from './helpers/mergeOutlookConditionnals'
import minifyOutlookConditionnals from './helpers/minifyOutlookConditionnals'
import defaultSkeleton from './helpers/skeleton'
import { initializeType } from './types/type'

import handleMjmlConfig, {
  readMjmlConfig,
  handleMjmlConfigComponents,
} from './helpers/mjmlconfig'

const isNode = require('detect-node')

class ValidationError extends Error {
  constructor(message, errors) {
    super(message)

    this.errors = errors
  }
}

export default function mjml2html(mjml, options = {}) {
  let content = ''
  let errors = []

  if (isNode && typeof options.skeleton === 'string') {
    /* eslint-disable global-require */
    /* eslint-disable import/no-dynamic-require */
    options.skeleton = require(options.skeleton.charAt(0) === '.'
      ? path.resolve(process.cwd(), options.skeleton)
      : options.skeleton)
    /* eslint-enable global-require */
    /* eslint-enable import/no-dynamic-require */
  }

  let packages = {}
  let confOptions = {}
  let mjmlConfigOptions = {}
  let error = null
  let componentRootPath = null

  if ((isNode && options.useMjmlConfigOptions) || options.mjmlConfigPath) {
    const mjmlConfigContent = readMjmlConfig(options.mjmlConfigPath)

    ;({
      mjmlConfig: { packages, options: confOptions },
      componentRootPath,
      error,
    } = mjmlConfigContent)

    if (options.useMjmlConfigOptions) {
      mjmlConfigOptions = confOptions
    }
  }

  // if mjmlConfigPath is specified then we need to register components it on each call
  if (isNode && !error && options.mjmlConfigPath) {
    handleMjmlConfigComponents(packages, componentRootPath, registerComponent)
  }

  const {
    beautify = false,
    fonts = {
      'Open Sans':
        'https://fonts.googleapis.com/css?family=Open+Sans:300,400,500,700',
      'Droid Sans':
        'https://fonts.googleapis.com/css?family=Droid+Sans:300,400,500,700',
      Lato: 'https://fonts.googleapis.com/css?family=Lato:300,400,500,700',
      Roboto: 'https://fonts.googleapis.com/css?family=Roboto:300,400,500,700',
      Ubuntu: 'https://fonts.googleapis.com/css?family=Ubuntu:300,400,500,700',
    },
    keepComments,
    minify = false,
    minifyOptions = {},
    ignoreIncludes = false,
    juiceOptions = {},
    juicePreserveTags = null,
    skeleton = defaultSkeleton,
    validationLevel = 'soft',
    filePath = '.',
    actualPath = '.',
    preprocessors,
    presets = [],
  } = {
    ...mjmlConfigOptions,
    ...options,
  }

  const components = { ...globalComponents }
  const dependencies = assignDependencies({}, globalDependencies)
  for (const preset of presets) {
    assignComponents(components, preset.components)
    assignDependencies(dependencies, preset.dependencies)
  }

  if (typeof mjml === 'string') {
    mjml = MJMLParser(mjml, {
      keepComments,
      components,
      filePath,
      actualPath,
      preprocessors,
      ignoreIncludes,
    })
  }

  const globalDatas = {
    backgroundColor: '',
    breakpoint: '480px',
    classes: {},
    classesDefault: {},
    defaultAttributes: {},
    htmlAttributes: {},
    fonts,
    inlineStyle: [],
    headStyle: {},
    componentsHeadStyle: [],
    headRaw: [],
    mediaQueries: {},
    preview: '',
    style: [],
    title: '',
    lang: get(mjml, 'attributes.lang'),
  }

  const validatorOptions = {
    components,
    dependencies,
    initializeType,
  }

  switch (validationLevel) {
    case 'skip':
      break

    case 'strict':
      errors = MJMLValidator(mjml, validatorOptions)

      if (errors.length > 0) {
        throw new ValidationError(
          `ValidationError: \n ${errors
            .map((e) => e.formattedMessage)
            .join('\n')}`,
          errors,
        )
      }
      break

    case 'soft':
    default:
      errors = MJMLValidator(mjml, validatorOptions)
      break
  }

  const mjBody = find(mjml.children, { tagName: 'mj-body' })
  const mjHead = find(mjml.children, { tagName: 'mj-head' })

  const processing = (node, context, parseMJML = identity) => {
    if (!node) {
      return
    }

    const component = initComponent({
      name: node.tagName,
      initialDatas: {
        ...parseMJML(node),
        context,
      },
    })

    if (component !== null) {
      if ('handler' in component) {
        return component.handler() // eslint-disable-line consistent-return
      }

      if ('render' in component) {
        return component.render() // eslint-disable-line consistent-return
      }
    }
  }

  const applyAttributes = (mjml) => {
    const parse = (mjml, parentMjClass = '') => {
      const { attributes, tagName, children } = mjml
      const classes = get(mjml.attributes, 'mj-class', '').split(' ')
      const attributesClasses = reduce(
        classes,
        (acc, value) => {
          const mjClassValues = globalDatas.classes[value]
          let multipleClasses = {}
          if (acc['css-class'] && get(mjClassValues, 'css-class')) {
            multipleClasses = {
              'css-class': `${acc['css-class']} ${mjClassValues['css-class']}`,
            }
          }

          return {
            ...acc,
            ...mjClassValues,
            ...multipleClasses,
          }
        },
        {},
      )

      const defaultAttributesForClasses = reduce(
        parentMjClass.split(' '),
        (acc, value) => ({
          ...acc,
          ...get(globalDatas.classesDefault, `${value}.${tagName}`),
        }),
        {},
      )
      const nextParentMjClass = get(attributes, 'mj-class', parentMjClass)

      return {
        ...mjml,
        attributes: {
          ...globalDatas.defaultAttributes[tagName],
          ...attributesClasses,
          ...defaultAttributesForClasses,
          ...omit(attributes, ['mj-class']),
        },
        globalAttributes: {
          ...globalDatas.defaultAttributes['mj-all'],
        },
        children: map(children, (mjml) => parse(mjml, nextParentMjClass)),
      }
    }

    return parse(mjml)
  }

  const bodyHelpers = {
    components,
    addMediaQuery(className, { parsedWidth, unit }) {
      globalDatas.mediaQueries[
        className
      ] = `{ width:${parsedWidth}${unit} !important; max-width: ${parsedWidth}${unit}; }`
    },
    addHeadStyle(identifier, headStyle) {
      globalDatas.headStyle[identifier] = headStyle
    },
    addComponentHeadSyle(headStyle) {
      globalDatas.componentsHeadStyle.push(headStyle)
    },
    setBackgroundColor: (color) => {
      globalDatas.backgroundColor = color
    },
    processing: (node, context) => processing(node, context, applyAttributes),
  }

  const headHelpers = {
    components,
    add(attr, ...params) {
      if (Array.isArray(globalDatas[attr])) {
        globalDatas[attr].push(...params)
      } else if (Object.prototype.hasOwnProperty.call(globalDatas, attr)) {
        if (params.length > 1) {
          if (isObject(globalDatas[attr][params[0]])) {
            globalDatas[attr][params[0]] = {
              ...globalDatas[attr][params[0]],
              ...params[1],
            }
          } else {
            // eslint-disable-next-line prefer-destructuring
            globalDatas[attr][params[0]] = params[1]
          }
        } else {
          // eslint-disable-next-line prefer-destructuring
          globalDatas[attr] = params[0]
        }
      } else {
        throw Error(
          `An mj-head element add an unkown head attribute : ${attr} with params ${
            Array.isArray(params) ? params.join('') : params
          }`,
        )
      }
    },
  }

  globalDatas.headRaw = processing(mjHead, headHelpers)

  content = processing(mjBody, bodyHelpers, applyAttributes)

  content = minifyOutlookConditionnals(content)

  if (!isEmpty(globalDatas.htmlAttributes)) {
    const $ = cheerio.load(content, {
      xmlMode: true, // otherwise it may move contents that aren't in any tag
      decodeEntities: false, // won't escape special characters
    })

    each(globalDatas.htmlAttributes, (data, selector) => {
      each(data, (value, attrName) => {
        $(selector).each(function getAttr() {
          $(this).attr(attrName, value || '')
        })
      })
    })

    content = $.root().html()
  }

  content = skeleton({
    content,
    ...globalDatas,
  })

  if (globalDatas.inlineStyle.length > 0) {
    if (juicePreserveTags) {
      each(juicePreserveTags, (val, key) => {
        juice.codeBlocks[key] = val
      })
    }

    content = juice(content, {
      applyStyleTags: false,
      extraCss: globalDatas.inlineStyle.join(''),
      insertPreservedExtraCss: false,
      removeStyleTags: false,
      ...juiceOptions,
    })
  }

  content = mergeOutlookConditionnals(content)

  if (beautify) {
    // eslint-disable-next-line no-console
    console.warn(
      '"beautify" option has been removed in mjml-core and only available in mjml cli.',
    )
  }
  if (minify) {
    // eslint-disable-next-line no-console
    console.warn(
      '"minify" option has been removed in mjml-core and only available in mjml cli.',
    )
  }

  return {
    html: content,
    json: mjml,
    errors,
  }
}

if (isNode) {
  handleMjmlConfig(process.cwd(), registerComponent)
}

export {
  globalComponents as components,
  initComponent,
  registerComponent,
  assignComponents,
  suffixCssClasses,
  handleMjmlConfig,
  initializeType,
}

export { BodyComponent, HeadComponent } from './createComponent'
