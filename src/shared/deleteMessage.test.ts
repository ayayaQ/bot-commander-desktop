import { describe, expect, it } from 'vitest'
import {
  classifyDeleteMessageError,
  DELETE_MESSAGE_ERRORS,
  validateDeleteMessageArguments
} from './deleteMessage'
import { bcfdItems } from './bcfdLanguage'

describe('deleteMessage shared contract', () => {
  it.each([
    '1',
    '9007199254740993',
    '9223372036854775808',
    '18446744073709551615',
    ' \t\n123\r ',
    '\u00a0123\u00a0',
    '\ufeff123\ufeff'
  ])('validates and preserves a string ID losslessly: %j', (value) => {
    expect(validateDeleteMessageArguments([value])).toEqual({ id: value.trim() })
  })

  it.each([
    '',
    ' ',
    '0',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e3',
    '1 2',
    '１２３',
    '١٢٣',
    '18446744073709551616',
    '100000000000000000000',
    '<@123>',
    'https://discord.com/channels/1/2/3',
    '\u001c123\u001c',
    '\u0085123\u0085',
    '\u200b123\u200b'
  ])('rejects a noncanonical or out-of-range ID: %j', (value) => {
    expect(validateDeleteMessageArguments([value])).toEqual({
      error: DELETE_MESSAGE_ERRORS.invalidId
    })
  })

  it('validates arity before values and rejects nonstrings', () => {
    expect(validateDeleteMessageArguments([])).toEqual({ error: DELETE_MESSAGE_ERRORS.arity })
    expect(validateDeleteMessageArguments(['bad', 'bad'])).toEqual({
      error: DELETE_MESSAGE_ERRORS.arity
    })
    expect(validateDeleteMessageArguments([123 as unknown as string])).toEqual({
      error: DELETE_MESSAGE_ERRORS.invalidId
    })
  })

  it.each([
    [10008, DELETE_MESSAGE_ERRORS.missingMessage],
    [10003, DELETE_MESSAGE_ERRORS.missingChannel],
    [50001, DELETE_MESSAGE_ERRORS.access],
    [50013, DELETE_MESSAGE_ERRORS.permission],
    [50003, DELETE_MESSAGE_ERRORS.permission],
    [99999, DELETE_MESSAGE_ERRORS.failed]
  ])('classifies Discord code %s without exposing its raw details', (code, expected) => {
    expect(classifyDeleteMessageError({ code, message: 'private raw detail' })).toBe(expected)
    expect(classifyDeleteMessageError({ code: String(code) })).toBe(expected)
  })

  it('uses a deterministic generic error for unclassified failures', () => {
    for (const error of [
      undefined,
      null,
      'secret error',
      new Error('private detail'),
      { status: 403 }
    ])
      expect(classifyDeleteMessageError(error)).toBe(DELETE_MESSAGE_ERRORS.failed)
  })

  it('advertises the requested syntax in autocomplete', () => {
    expect(bcfdItems.find((item) => item.name === 'deleteMessage')).toMatchObject({
      syntax: 'function-paren',
      insertText: 'deleteMessage(MessageId)'
    })
  })
})
