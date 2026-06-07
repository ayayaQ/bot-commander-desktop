export type BCFDItemSyntax = 'variable' | 'function-paren' | 'function-brace' | 'keyword'

export interface BCFDLanguageItem {
  name: string
  syntax: BCFDItemSyntax
  description: string
  insertText?: string
}

export const bcfdItems: BCFDLanguageItem[] = [
  {
    name: 'eval',
    syntax: 'keyword',
    description: 'Start JavaScript eval block',
    insertText: 'eval\n\n$halt'
  },
  { name: 'halt', syntax: 'keyword', description: 'End JavaScript eval block' },
  { name: 'if', syntax: 'keyword', description: 'Conditional block', insertText: 'if()\n\n$endif' },
  { name: 'elseif', syntax: 'keyword', description: 'Else-if branch', insertText: 'elseif()' },
  { name: 'else', syntax: 'keyword', description: 'Else branch' },
  { name: 'endif', syntax: 'keyword', description: 'End if block' },

  { name: 'name', syntax: 'variable', description: 'User mention (e.g. @User)' },
  { name: 'namePlain', syntax: 'variable', description: 'User display name (plain text)' },
  { name: 'avatar', syntax: 'variable', description: 'User avatar URL' },
  { name: 'discriminator', syntax: 'variable', description: 'User discriminator' },
  { name: 'tag', syntax: 'variable', description: 'User tag (e.g. User#1234)' },
  { name: 'id', syntax: 'variable', description: 'User ID' },
  { name: 'isBot', syntax: 'variable', description: 'Is user a bot' },
  { name: 'globalName', syntax: 'variable', description: 'User global display name' },
  { name: 'timeCreated', syntax: 'variable', description: 'User account creation time' },
  {
    name: 'timeCreatedDiscord',
    syntax: 'variable',
    description: 'User account creation time as Discord timestamp'
  },
  { name: 'defaultavatar', syntax: 'variable', description: 'User default avatar URL' },

  { name: 'memberIsOwner', syntax: 'variable', description: 'Is member the server owner' },
  { name: 'memberEffectiveName', syntax: 'variable', description: 'Member display name' },
  { name: 'memberNickname', syntax: 'variable', description: 'Member nickname' },
  { name: 'memberID', syntax: 'variable', description: 'Member ID' },
  { name: 'memberHasTimeJoined', syntax: 'variable', description: 'Has member join time' },
  { name: 'memberTimeJoined', syntax: 'variable', description: 'Member join time' },
  {
    name: 'memberTimeJoinedDiscord',
    syntax: 'variable',
    description: 'Member join time as Discord timestamp'
  },
  { name: 'memberEffectiveAvatar', syntax: 'variable', description: 'Member effective avatar' },
  { name: 'memberEffectiveTag', syntax: 'variable', description: 'Member effective tag' },
  { name: 'memberEffectiveID', syntax: 'variable', description: 'Member effective ID' },
  {
    name: 'memberEffectiveTimeCreated',
    syntax: 'variable',
    description: 'Member account creation time'
  },
  {
    name: 'memberEffectiveTimeCreatedDiscord',
    syntax: 'variable',
    description: 'Member account creation time as Discord timestamp'
  },
  {
    name: 'memberEffectiveDefaultAvatar',
    syntax: 'variable',
    description: 'Member default avatar'
  },
  { name: 'memberTimeBoosted', syntax: 'variable', description: 'When member started boosting' },
  {
    name: 'memberTimeBoostedDiscord',
    syntax: 'variable',
    description: 'Member boost time as Discord timestamp'
  },
  { name: 'memberHasBoosted', syntax: 'variable', description: 'Is member boosting' },
  { name: 'memberColor', syntax: 'variable', description: 'Member display color' },
  { name: 'memberRoles', syntax: 'variable', description: 'Member roles' },
  { name: 'memberRoleCount', syntax: 'variable', description: 'Number of member roles' },

  { name: 'ping', syntax: 'variable', description: 'Bot WebSocket ping (ms)' },
  { name: 'inviteURL', syntax: 'variable', description: 'Bot invite URL' },
  { name: 'serverCount', syntax: 'variable', description: 'Number of servers bot is in' },
  { name: 'allMemberCount', syntax: 'variable', description: 'Total cached member count' },
  { name: 'botAvatar', syntax: 'variable', description: 'Bot avatar URL' },
  { name: 'botName', syntax: 'variable', description: 'Bot mention' },
  { name: 'botNamePlain', syntax: 'variable', description: 'Bot display name' },
  { name: 'botID', syntax: 'variable', description: 'Bot user ID' },
  { name: 'botTimeCreated', syntax: 'variable', description: 'Bot account creation time' },
  {
    name: 'botTimeCreatedDiscord',
    syntax: 'variable',
    description: 'Bot account creation time as Discord timestamp'
  },
  { name: 'botDefaultAvatar', syntax: 'variable', description: 'Bot default avatar URL' },
  { name: 'botDiscriminator', syntax: 'variable', description: 'Bot discriminator' },
  { name: 'botTag', syntax: 'variable', description: 'Bot tag' },

  { name: 'server', syntax: 'variable', description: 'Server name' },
  { name: 'serverIcon', syntax: 'variable', description: 'Server icon URL' },
  { name: 'serverBanner', syntax: 'variable', description: 'Server banner URL' },
  { name: 'serverDescription', syntax: 'variable', description: 'Server description' },
  { name: 'serverSplash', syntax: 'variable', description: 'Server splash URL' },
  { name: 'serverCreateTime', syntax: 'variable', description: 'Server creation time' },
  {
    name: 'serverCreateTimeDiscord',
    syntax: 'variable',
    description: 'Server creation time as Discord timestamp'
  },
  { name: 'memberCount', syntax: 'variable', description: 'Server member count' },
  { name: 'serverID', syntax: 'variable', description: 'Server ID' },
  { name: 'serverOwner', syntax: 'variable', description: 'Server owner mention' },
  { name: 'serverOwnerPlain', syntax: 'variable', description: 'Server owner display name' },
  { name: 'serverBoostCount', syntax: 'variable', description: 'Server boost count' },
  { name: 'serverBoostTier', syntax: 'variable', description: 'Server boost tier' },
  { name: 'serverVanityCode', syntax: 'variable', description: 'Server vanity invite code' },

  { name: 'channel', syntax: 'variable', description: 'Channel name' },
  { name: 'channelID', syntax: 'variable', description: 'Channel ID' },
  { name: 'channelCreateDate', syntax: 'variable', description: 'Channel creation date' },
  {
    name: 'channelCreateDateDiscord',
    syntax: 'variable',
    description: 'Channel creation date as Discord timestamp'
  },
  { name: 'channelAsMention', syntax: 'variable', description: 'Channel mention (e.g. #general)' },
  { name: 'channelTopic', syntax: 'variable', description: 'Channel topic' },
  { name: 'channelIsNSFW', syntax: 'variable', description: 'Is channel NSFW (true/false)' },
  { name: 'channelCount', syntax: 'variable', description: 'Total channel count in server' },

  {
    name: 'createChannel',
    syntax: 'function-paren',
    description: 'Create a new channel',
    insertText: 'createChannel(name, type)'
  },
  {
    name: 'createPrivateChannel',
    syntax: 'function-paren',
    description: 'Create a private channel for the caller',
    insertText: 'createPrivateChannel(name, type)'
  },
  {
    name: 'createChannelIn',
    syntax: 'function-paren',
    description: 'Create channel in category',
    insertText: 'createChannelIn(name, type, categoryID)'
  },
  {
    name: 'cloneChannel',
    syntax: 'function-paren',
    description: 'Clone an existing channel',
    insertText: 'cloneChannel(channelID)'
  },
  {
    name: 'deleteChannel',
    syntax: 'function-paren',
    description: 'Delete a channel',
    insertText: 'deleteChannel(channelID, reason)'
  },
  {
    name: 'setChannelName',
    syntax: 'function-paren',
    description: 'Rename a channel',
    insertText: 'setChannelName(channelID, name)'
  },
  {
    name: 'setChannelTopic',
    syntax: 'function-paren',
    description: 'Set channel topic',
    insertText: 'setChannelTopic(channelID, topic)'
  },
  {
    name: 'setChannelNSFW',
    syntax: 'function-paren',
    description: 'Set channel NSFW flag',
    insertText: 'setChannelNSFW(channelID, true)'
  },
  {
    name: 'setChannelSlowmode',
    syntax: 'function-paren',
    description: 'Set slowmode delay (0-21600s)',
    insertText: 'setChannelSlowmode(channelID, seconds)'
  },
  {
    name: 'setChannelPosition',
    syntax: 'function-paren',
    description: 'Set channel position',
    insertText: 'setChannelPosition(channelID, position)'
  },
  {
    name: 'setChannelParent',
    syntax: 'function-paren',
    description: 'Move channel to category',
    insertText: 'setChannelParent(channelID, categoryID)'
  },
  {
    name: 'findChannel',
    syntax: 'function-paren',
    description: 'Find channel by name',
    insertText: 'findChannel(name)'
  },
  {
    name: 'getChannelName',
    syntax: 'function-paren',
    description: 'Get channel name by ID',
    insertText: 'getChannelName(channelID)'
  },
  {
    name: 'getChannelType',
    syntax: 'function-paren',
    description: 'Get channel type',
    insertText: 'getChannelType(channelID)'
  },
  {
    name: 'getChannelParent',
    syntax: 'function-paren',
    description: 'Get parent category ID',
    insertText: 'getChannelParent(channelID)'
  },
  {
    name: 'listChannels',
    syntax: 'function-paren',
    description: 'List channel names by type',
    insertText: 'listChannels(type)'
  },
  {
    name: 'listChannelIDs',
    syntax: 'function-paren',
    description: 'List channel IDs by type',
    insertText: 'listChannelIDs(type)'
  },
  {
    name: 'lockChannel',
    syntax: 'function-paren',
    description: 'Lock channel for a role',
    insertText: 'lockChannel(channelID, roleID)'
  },
  {
    name: 'unlockChannel',
    syntax: 'function-paren',
    description: 'Unlock channel for a role',
    insertText: 'unlockChannel(channelID, roleID)'
  },
  {
    name: 'channelMention',
    syntax: 'function-paren',
    description: 'Format channel ID as mention',
    insertText: 'channelMention(channelID)'
  },

  { name: 'mentionedName', syntax: 'variable', description: 'Mentioned user mention' },
  { name: 'mentionedID', syntax: 'variable', description: 'Mentioned user ID' },
  { name: 'mentionedTag', syntax: 'variable', description: 'Mentioned user tag' },
  {
    name: 'mentionedDiscriminator',
    syntax: 'variable',
    description: 'Mentioned user discriminator'
  },
  { name: 'mentionedAvatar', syntax: 'variable', description: 'Mentioned user avatar' },
  { name: 'mentionedTimeCreated', syntax: 'variable', description: 'Mentioned user creation time' },
  {
    name: 'mentionedTimeCreatedDiscord',
    syntax: 'variable',
    description: 'Mentioned user creation time as Discord timestamp'
  },
  { name: 'mentionedNamePlain', syntax: 'variable', description: 'Mentioned user display name' },
  {
    name: 'mentionedDefaultAvatar',
    syntax: 'variable',
    description: 'Mentioned user default avatar'
  },
  { name: 'mentionedIsBot', syntax: 'variable', description: 'Is mentioned user a bot' },
  {
    name: 'mentionedGlobalName',
    syntax: 'variable',
    description: 'Mentioned user global display name'
  },

  { name: 'randomInt', syntax: 'variable', description: 'Random integer 0-99' },
  { name: 'randomFloat', syntax: 'variable', description: 'Random float 0-1' },
  { name: 'randomBoolean', syntax: 'variable', description: 'Random true/false' },
  { name: 'commandCount', syntax: 'variable', description: 'Number of BCFD commands' },
  { name: 'date', syntax: 'variable', description: 'Current date/time' },
  {
    name: 'dateDiscord',
    syntax: 'variable',
    description: 'Current date/time as Discord timestamp'
  },
  { name: 'hours', syntax: 'variable', description: 'Current hour (00-23)' },
  { name: 'minutes', syntax: 'variable', description: 'Current minute (00-59)' },
  { name: 'seconds', syntax: 'variable', description: 'Current second (00-59)' },
  { name: 'message', syntax: 'variable', description: 'Full message content' },
  { name: 'messageAfterCommand', syntax: 'variable', description: 'Message after command' },
  { name: 'argsCount', syntax: 'variable', description: 'Number of arguments' },

  {
    name: 'random',
    syntax: 'function-brace',
    description: 'Pick random option',
    insertText: 'random{|}'
  },
  {
    name: 'rollnum',
    syntax: 'function-paren',
    description: 'Random number in range',
    insertText: 'rollnum(min, max)'
  },
  {
    name: 'sum',
    syntax: 'function-paren',
    description: 'Sum of numbers',
    insertText: 'sum(n1, n2)'
  },
  {
    name: 'sub',
    syntax: 'function-paren',
    description: 'Subtract two numbers',
    insertText: 'sub(a, b)'
  },
  {
    name: 'mul',
    syntax: 'function-paren',
    description: 'Multiply numbers',
    insertText: 'mul(n1, n2)'
  },
  {
    name: 'div',
    syntax: 'function-paren',
    description: 'Divide two numbers',
    insertText: 'div(a, b)'
  },
  {
    name: 'mod',
    syntax: 'function-paren',
    description: 'Modulo of two numbers',
    insertText: 'mod(a, b)'
  },
  {
    name: 'round',
    syntax: 'function-paren',
    description: 'Round to nearest integer or N decimals',
    insertText: 'round(n, decimals)'
  },
  { name: 'floor', syntax: 'function-paren', description: 'Round down', insertText: 'floor(n)' },
  { name: 'ceil', syntax: 'function-paren', description: 'Round up', insertText: 'ceil(n)' },
  { name: 'abs', syntax: 'function-paren', description: 'Absolute value', insertText: 'abs(n)' },
  {
    name: 'toFixed',
    syntax: 'function-paren',
    description: 'Format to fixed decimal places',
    insertText: 'toFixed(n, decimals)'
  },
  {
    name: 'min',
    syntax: 'function-paren',
    description: 'Minimum of numbers',
    insertText: 'min(n1, n2)'
  },
  {
    name: 'max',
    syntax: 'function-paren',
    description: 'Maximum of numbers',
    insertText: 'max(n1, n2)'
  },
  {
    name: 'clamp',
    syntax: 'function-paren',
    description: 'Clamp value between min and max',
    insertText: 'clamp(n, min, max)'
  },
  {
    name: 'pow',
    syntax: 'function-paren',
    description: 'Exponentiation',
    insertText: 'pow(base, exp)'
  },
  { name: 'sqrt', syntax: 'function-paren', description: 'Square root', insertText: 'sqrt(n)' },
  { name: 'log', syntax: 'function-paren', description: 'Natural logarithm', insertText: 'log(n)' },
  { name: 'pi', syntax: 'variable', description: 'Pi constant (3.14159...)' },
  {
    name: 'isNumber',
    syntax: 'function-paren',
    description: 'Check if text is a valid number',
    insertText: 'isNumber(text)'
  },
  {
    name: 'upper',
    syntax: 'function-paren',
    description: 'Convert text to uppercase',
    insertText: 'upper(text)'
  },
  {
    name: 'lower',
    syntax: 'function-paren',
    description: 'Convert text to lowercase',
    insertText: 'lower(text)'
  },
  {
    name: 'length',
    syntax: 'function-paren',
    description: 'Get text length',
    insertText: 'length(text)'
  },
  {
    name: 'replace',
    syntax: 'function-paren',
    description: 'Replace all occurrences in text',
    insertText: 'replace(text, find, replacement)'
  },
  {
    name: 'substring',
    syntax: 'function-paren',
    description: 'Extract part of text',
    insertText: 'substring(text, start, end)'
  },
  {
    name: 'trim',
    syntax: 'function-paren',
    description: 'Trim whitespace from text',
    insertText: 'trim(text)'
  },
  {
    name: 'repeat',
    syntax: 'function-paren',
    description: 'Repeat text',
    insertText: 'repeat(text, count)'
  },
  {
    name: 'args',
    syntax: 'function-paren',
    description: 'Get argument at index',
    insertText: 'args(0)'
  },
  {
    name: 'set',
    syntax: 'function-paren',
    description: 'Store a variable',
    insertText: 'set(name, value)'
  },
  {
    name: 'get',
    syntax: 'function-paren',
    description: 'Retrieve a variable',
    insertText: 'get(name)'
  },
  {
    name: 'chat',
    syntax: 'function-paren',
    description: 'AI chat response',
    insertText: 'chat(prompt)'
  },
  {
    name: 'option',
    syntax: 'function-paren',
    description: 'Get option value (interaction commands)',
    insertText: 'option(name)'
  },
  {
    name: 'contains',
    syntax: 'function-paren',
    description: 'Check if text contains search string',
    insertText: 'contains(text, search)'
  },
  {
    name: 'startsWith',
    syntax: 'function-paren',
    description: 'Check if text starts with prefix',
    insertText: 'startsWith(text, prefix)'
  },
  {
    name: 'endsWith',
    syntax: 'function-paren',
    description: 'Check if text ends with suffix',
    insertText: 'endsWith(text, suffix)'
  },
  {
    name: 'cooldownRemaining',
    syntax: 'function-paren',
    description: 'Get remaining cooldown seconds',
    insertText: 'cooldownRemaining(level)'
  }
]

export const bcfdItemNames = new Set(bcfdItems.map((item) => item.name))
