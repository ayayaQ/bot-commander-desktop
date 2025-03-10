import { writable, derived } from 'svelte/store'

// Types
type TranslationDictionary = {
  [key: string]: string
}

type Languages = {
  [key: string]: TranslationDictionary
}

// Default language
const DEFAULT_LANGUAGE = 'en'

// Translation dictionaries
const translations: Languages = {
  en: {
    'version-value': '1.0.0',
    'send-webhook': 'Send Discord Webhook',
    'webhook-url': 'Webhook URL',
    name: 'Name',
    avatar: 'Avatar URL',
    message: 'Message',
    send: 'Send',
    bot: 'Bot',
    'message-placeholder': 'Enter your message here',
    token: 'Token',
    login: 'Login',
    logout: 'Logout',
    invite: 'Invite',
    status: 'Status',
    activity: 'Activity',
    'status-details': 'Status Details',
    'status-details-placeholder': 'Enter your status details here',
    'twitch-url': 'Twitch.tv URL',
    'update-status': 'Update Status',
    settings: 'Settings',
    theme: 'Theme',
    'show-token': 'Show Token',
    language: 'Language',
    about: 'About',
    'bot-state': 'Bot State',
    value: 'Value',
    'run-code': 'Run Code',
    'run-code-placeholder': 'Enter JavaScript code here...',
    output: 'Output',
    run: 'Run',
    stats: 'Stats',
    users: 'Users',
    'messages-sent': 'Messages Sent',
    'messages-received': 'Messages Received',
    'on-join': 'On Join',
    'on-leave': 'On Leave',
    'on-ban': 'On Ban',
    'private-messages-received': 'Private Messages Received',
    servers: 'Servers',
    commands: 'Commands',
    'time-spent-in-app': 'Time Spent in App',
    'webhooks-sent': 'Webhooks Sent',
    cancel: 'Cancel',
    'add-command': 'Add Command',
    'no-commands-found': 'No commands found.',
    'command-exported-to-clipboard': 'Command exported to clipboard!',
    delete: 'Delete',
    'are-you-sure-you-want-to-delete-the-command': 'Are you sure you want to delete the command?',
    'open-quote': '“',
    'close-quote': '”',
    'edit-command': 'Edit Command',
    'choose-command-type': 'Choose Command Type',
    'message-received': 'Message Received',
    'private-message-received': 'Private Message Received',
    'member-join': 'Member Join',
    'member-leave': 'Member Leave',
    'member-ban': 'Member Ban',
    reaction: 'Reaction',
    command: 'Command',
    description: 'Description',
    'reaction-placeholder': 'Emoji ID or name or 😊',
    'specific-message-only': 'Specific Message Only',
    'message-id': 'Message ID',
    phrase: 'Phrase',
    'requires-role': 'Requires Role',
    'required-role': 'Required Role',
    'role-id': 'Role ID',
    'requires-admin': 'Requires Admin',
    'send-message': 'Send Message',
    'channel-message': 'Channel Message',
    'send-channel-embed': 'Send Channel Embed',
    'channel-embed-title': 'Channel Embed Title',
    'channel-embed-description': 'Channel Embed Description',
    'channel-embed-footer': 'Channel Embed Footer',
    'channel-embed-image': 'Channel Embed Image',
    'channel-embed-thumbnail': 'Channel Embed Thumbnail',
    'channel-embed-color': 'Channel Embed Color',
    'is-specific-channel': 'Is Specific Channel',
    'specific-channel': 'Specific Channel',
    'send-private-message': 'Send Private Message',
    'private-message': 'Private Message',
    'send-private-embed': 'Send Private Embed',
    'private-embed-title': 'Private Embed Title',
    'private-embed-description': 'Private Embed Description',
    'private-embed-footer': 'Private Embed Footer',
    'private-embed-image': 'Private Embed Image',
    'private-embed-thumbnail': 'Private Embed Thumbnail',
    'private-embed-color': 'Private Embed Color',
    'react-to-message': 'React To Message',
    'ignore-error-message': 'Ignore Error Message',
    'delete-if-contains': 'Delete If Contains',
    'delete-if-strings': 'Delete If Strings',
    'delete-after': 'Delete After',
    'delete-x-times': 'Delete X Times',
    'delete-num': 'Delete Num',
    'is-nsfw': 'Is NSFW',
    moderation: 'Moderation',
    kick: 'Kick',
    ban: 'Ban',
    'voice-mute': 'Voice Mute',
    'role-assigner': 'Role Assign',
    'role-to-assign': 'Role To Assign',
    'update-command': 'Update Command',
    action: 'Action',
    hours: 'h',
    minutes: 'm',
    seconds: 's',
    'status-online': 'Online',
    'status-idle': 'Idle',
    'status-dnd': 'Do Not Disturb',
    'status-invisible': 'Invisible',
    'activity-playing': 'Playing',
    'activity-streaming': 'Streaming',
    'activity-listening': 'Listening',
    'activity-watching': 'Watching',
    'activity-none': 'None',
    'activity-competing': 'Competing',
    'language-tooltip': 'The language may be machine translated.',
    'no-state-data': 'No state data found.',
    help: 'Help'
    // ... more English strings
  },
  es: {
    'send-webhook': 'Enviar Webhook de Discord',
    'webhook-url': 'URL del Webhook',
    name: 'Nombre',
    avatar: 'URL del Avatar',
    message: 'Mensaje',
    send: 'Enviar',
    bot: 'Bot',
    'message-placeholder': 'Escribe tu mensaje aquí',
    token: 'Token',
    login: 'Iniciar sesión',
    logout: 'Cerrar sesión',
    invite: 'Invitar',
    status: 'Estado',
    activity: 'Actividad',
    'status-details': 'Detalles del estado',
    'status-details-placeholder': 'Escribe los detalles de tu estado aquí',
    'twitch-url': 'URL de Twitch.tv',
    'update-status': 'Actualizar estado',
    settings: 'Configuración',
    theme: 'Tema',
    'show-token': 'Mostrar token',
    language: 'Idioma',
    about: 'Acerca de',
    'bot-state': 'Estado del bot',
    value: 'Valor',
    'run-code': 'Ejecutar código',
    'run-code-placeholder': 'Escribe el código JavaScript aquí...',
    output: 'Salida',
    run: 'Ejecutar',
    stats: 'Estadísticas',
    users: 'Usuarios',
    'messages-sent': 'Mensajes enviados',
    'messages-received': 'Mensajes recibidos',
    'on-join': 'En unirse',
    'on-leave': 'En abandonar',
    'on-ban': 'En banear',
    'private-messages-received': 'Mensajes privados recibidos',
    servers: 'Servidores',
    commands: 'Comandos',
    'time-spent-in-app': 'Tiempo en la aplicación',
    'webhooks-sent': 'Webhooks enviados',
    cancel: 'Cancelar',
    'add-command': 'Añadir comando',
    'no-commands-found': 'No se encontraron comandos.',
    'command-exported-to-clipboard': '¡Comando exportado al portapapeles!',
    delete: 'Eliminar',
    'are-you-sure-you-want-to-delete-the-command':
      '¿Estás seguro de que quieres eliminar el comando?',
    'open-quote': '“',
    'close-quote': '”',
    'edit-command': 'Editar comando',
    'choose-command-type': 'Escoge el tipo de comando',
    'message-received': 'Mensaje recibido',
    'private-message-received': 'Mensaje privado recibido',
    'member-join': 'Miembro se unió',
    'member-leave': 'Miembro abandonó',
    'member-ban': 'Miembro baneado',
    reaction: 'Reacción',
    command: 'Comando',
    description: 'Descripción',
    'reaction-placeholder': 'ID de emoji o nombre o 😊',
    'specific-message-only': 'Mensaje específico solo',
    'message-id': 'ID de mensaje',
    phrase: 'Frase',
    'requires-role': 'Requiere rol',
    'required-role': 'Rol requerido',
    'role-id': 'ID de rol',
    'requires-admin': 'Requiere admin',
    'send-message': 'Enviar mensaje',
    'channel-message': 'Mensaje de canal',
    'send-channel-embed': 'Enviar embed de canal',
    'channel-embed-title': 'Título del embed de canal',
    'channel-embed-description': 'Descripción del embed de canal',
    'channel-embed-footer': 'Pie de página del embed de canal',
    'channel-embed-image': 'Imagen del embed de canal',
    'channel-embed-thumbnail': 'Miniatura del embed de canal',
    'channel-embed-color': 'Color del embed de canal',
    'is-specific-channel': 'Es canal específico',
    'specific-channel': 'Canal específico',
    'send-private-message': 'Enviar mensaje privado',
    'private-message': 'Mensaje privado',
    'send-private-embed': 'Enviar embed privado',
    'private-embed-title': 'Título del embed privado',
    'private-embed-description': 'Descripción del embed privado',
    'private-embed-footer': 'Pie de página del embed privado',
    'private-embed-image': 'Imagen del embed privado',
    'private-embed-thumbnail': 'Miniatura del embed privado',
    'private-embed-color': 'Color del embed privado',
    'react-to-message': 'React to Message',
    'ignore-error-message': 'Ignorar mensaje de error',
    'delete-if-contains': 'Eliminar si contiene',
    'delete-if-strings': 'Eliminar si cadenas',
    'delete-after': 'Eliminar después',
    'delete-x-times': 'Eliminar X veces',
    'delete-num': 'Eliminar número',
    'is-nsfw': 'Es NSFW',
    moderation: 'Moderación',
    kick: 'Expulsar',
    ban: 'Banear',
    'voice-mute': 'Silenciar voz',
    'role-assigner': 'Asignar rol',
    'role-to-assign': 'Rol a asignar',
    'update-command': 'Actualizar comando',
    action: 'Acción',
    hours: 'h',
    minutes: 'm',
    seconds: 's',
    'status-online': 'En línea',
    'status-idle': 'Ocioso',
    'status-dnd': 'No Disturbiar',
    'status-invisible': 'Invisible',
    'activity-playing': 'Jugando',
    'activity-streaming': 'Transmitiendo',
    'activity-listening': 'Escuchando',
    'activity-watching': 'Viendo',
    'activity-none': 'Ninguno',
    'activity-competing': 'Competiendo',
    'language-tooltip': 'El idioma puede ser una traducción automática.',
    'no-state-data': 'No hay datos de estado.',
    help: 'Ayuda'
    // ... more Spanish strings
  },
  ja: {
    'send-webhook': 'Discord Webhookを送信',
    'webhook-url': 'Webhook URL',
    name: '名前',
    avatar: 'アバターURL',
    message: 'メッセージ',
    send: '送信',
    bot: 'ボット',
    'message-placeholder': 'ここにメッセージを入力してください',
    token: 'トークン',
    login: 'ログイン',
    logout: 'ログアウト',
    invite: '招待',
    status: 'ステータス',
    activity: 'アクティビティ',
    'status-details': 'ステータスの詳細',
    'status-details-placeholder': 'ここにステータスの詳細を入力してください',
    'twitch-url': 'Twitch.tv URL',
    'update-status': 'ステータスを更新',
    settings: '設定',
    theme: 'テーマ',
    'show-token': 'トークンを表示',
    language: '言語',
    about: '約',
    'bot-state': 'ボットの状態',
    value: '値',
    'run-code': 'コードを実行',
    'run-code-placeholder': 'ここにJavaScriptコードを入力してください...',
    output: '出力',
    run: '実行',
    stats: '統計',
    users: 'ユーザー',
    'messages-sent': '送信されたメッセージ',
    'messages-received': '受信したメッセージ',
    'on-join': '参加時',
    'on-leave': '退会時',
    'on-ban': '禁止時',
    'private-messages-received': '受信したプライベートメッセージ',
    servers: 'サーバー',
    commands: 'コマンド',
    'time-spent-in-app': 'アプリでの時間',
    'webhooks-sent': '送信されたWebhook',
    cancel: 'キャンセル',
    'add-command': 'コマンドを追加',
    'no-commands-found': 'コマンドが見つかりません。',
    'command-exported-to-clipboard': 'コマンドがクリップボードにエクスポートされました！',
    delete: '削除',
    'are-you-sure-you-want-to-delete-the-command': 'コマンドを削除してもよろしいですか？',
    'open-quote': '「',
    'close-quote': '」',
    'edit-command': 'コマンドを編集',
    'choose-command-type': 'コマンドタイプを選択',
    'message-received': 'メッセージを受信',
    'private-message-received': 'プライベートメッセージを受信',
    'member-join': 'メンバー参加',
    'member-leave': 'メンバー退会',
    'member-ban': 'メンバー禁止',
    reaction: 'リアクション',
    command: 'コマンド',
    description: '説明',
    'reaction-placeholder': '絵文字IDまたは名前または😊',
    'specific-message-only': '特定のメッセージのみ',
    'message-id': 'メッセージID',
    phrase: 'フレーズ',
    'requires-role': '役割が必要',
    'required-role': '必要な役割',
    'role-id': '役割ID',
    'requires-admin': '管理者が必要',
    'send-message': 'メッセージを送信',
    'channel-message': 'チャンネルメッセージ',
    'send-channel-embed': 'チャンネル埋め込みを送信',
    'channel-embed-title': 'チャンネル埋め込みタイトル',
    'channel-embed-description': 'チャンネル埋め込み説明',
    'channel-embed-footer': 'チャンネル埋め込みフッター',
    'channel-embed-image': 'チャンネル埋め込み画像',
    'channel-embed-thumbnail': 'チャンネル埋め込みサムネイル',
    'channel-embed-color': 'チャンネル埋め込み色',
    'is-specific-channel': '特定のチャンネルです',
    'specific-channel': '特定のチャンネル',
    'send-private-message': 'プライベートメッセージを送信',
    'private-message': 'プライベートメッセージ',
    'send-private-embed': 'プライベート埋め込みを送信',
    'private-embed-title': 'プライベート埋め込みタイトル',
    'private-embed-description': 'プライベート埋め込み説明',
    'private-embed-footer': 'プライベート埋め込みフッター',
    'private-embed-image': 'プライベート埋め込み画像',
    'private-embed-thumbnail': 'プライベート埋め込みサムネイル',
    'private-embed-color': 'プライベート埋め込み色',
    'react-to-message': 'メッセージに反応',
    'ignore-error-message': 'エラーメッセージを無視',
    'delete-if-contains': '含まれている場合は削除',
    'delete-if-strings': '文字列の場合は削除',
    'delete-after': '後に削除',
    'delete-x-times': 'X回削除',
    'delete-num': '削除数',
    'is-nsfw': 'NSFWです',
    moderation: 'モデレーション',
    kick: 'キック',
    ban: '禁止',
    'voice-mute': 'ボイスミュート',
    'role-assigner': '役割を割り当てる',
    'role-to-assign': '割り当てる役割',
    'update-command': 'コマンドを更新',
    action: 'アクション',
    hours: '時間',
    minutes: '分',
    seconds: '秒',
    'status-online': 'オンライン',
    'status-idle': 'アイドル',
    'status-dnd': 'ドントディストラクト',
    'status-invisible': 'インビジブル',
    'activity-playing': 'プレイング',
    'activity-streaming': 'ストリーミング',
    'activity-listening': 'リスニング',
    'activity-watching': 'ウォッチング',
    'activity-none': 'ノーン',
    'activity-competing': 'コンペティング',
    'language-tooltip': '言語は自動翻訳される可能性があります。',
    'no-state-data': '状態データがありません。',
    help: 'ヘルプ'
    // ... more Japanese strings
  },
  zh: {
    'send-webhook': '发送Discord Webhook',
    'webhook-url': 'Webhook URL',
    name: '名称',
    avatar: '头像URL',
    message: '消息',
    send: '发送',
    bot: '机器人',
    'message-placeholder': '在此输入消息',
    token: '令牌',
    login: '登录',
    logout: '登出',
    invite: '邀请',
    status: '状态',
    activity: '活动',
    'status-details': '状态详情',
    'status-details-placeholder': '在此输入状态详情',
    'twitch-url': 'Twitch.tv URL',
    'update-status': '更新状态',
    settings: '设置',
    theme: '主题',
    'show-token': '显示令牌',
    language: '语言',
    about: '关于',
    'bot-state': '机器人状态',
    value: '值',
    'run-code': '运行代码',
    'run-code-placeholder': '在此输入JavaScript代码...',
    output: '输出',
    run: '运行',
    stats: '统计',
    users: '用户',
    'messages-sent': '已发送消息',
    'messages-received': '已接收消息',
    'on-join': '加入时',
    'on-leave': '离开时',
    'on-ban': '被禁时',
    'private-messages-received': '接收的私人消息',
    servers: '服务器',
    commands: '命令',
    'time-spent-in-app': '在应用中花费的时间',
    'webhooks-sent': '已发送的Webhook',
    cancel: '取消',
    'add-command': '添加命令',
    'no-commands-found': '未找到命令。',
    'command-exported-to-clipboard': '命令已导出到剪贴板！',
    delete: '删除',
    'are-you-sure-you-want-to-delete-the-command': '您确定要删除命令吗？',
    'open-quote': '“',
    'close-quote': '”',
    'edit-command': '编辑命令',
    'choose-command-type': '选择命令类型',
    'message-received': '收到消息',
    'private-message-received': '收到私人消息',
    'member-join': '成员加入',
    'member-leave': '成员离开',
    'member-ban': '成员被禁',
    reaction: '反应',
    command: '命令',
    description: '描述',
    'reaction-placeholder': '表情符号ID或名称或😊',
    'specific-message-only': '仅特定消息',
    'message-id': '消息ID',
    phrase: '短语',
    'requires-role': '需要角色',
    'required-role': '所需角色',
    'role-id': '角色ID',
    'requires-admin': '需要管理员',
    'send-message': '发送消息',
    'channel-message': '频道消息',
    'send-channel-embed': '发送频道嵌入',
    'channel-embed-title': '频道嵌入标题',
    'channel-embed-description': '频道嵌入描述',
    'channel-embed-footer': '频道嵌入页脚',
    'channel-embed-image': '频道嵌入图片',
    'channel-embed-thumbnail': '频道嵌入缩略图',
    'channel-embed-color': '频道嵌入颜色',
    'is-specific-channel': '是特定频道',
    'specific-channel': '特定频道',
    'send-private-message': '发送私人消息',
    'private-message': '私人消息',
    'send-private-embed': '发送私人嵌入',
    'private-embed-title': '私人嵌入标题',
    'private-embed-description': '私人嵌入描述',
    'private-embed-footer': '私人嵌入页脚',
    'private-embed-image': '私人嵌入图片',
    'private-embed-thumbnail': '私人嵌入缩略图',
    'private-embed-color': '私人嵌入颜色',
    'react-to-message': '对消息做出反应',
    'ignore-error-message': '忽略错误消息',
    'delete-if-contains': '如果包含则删除',
    'delete-if-strings': '如果是字符串则删除',
    'delete-after': '之后删除',
    'delete-x-times': '删除X次',
    'delete-num': '删除数量',
    'is-nsfw': '是NSFW',
    moderation: '管理',
    kick: '踢出',
    ban: '禁止',
    'voice-mute': '语音静音',
    'role-assigner': '角色分配器',
    'role-to-assign': '要分配的角色',
    'update-command': '更新命令',
    action: '动作',
    hours: '小时',
    minutes: '分钟',
    seconds: '秒',
    'status-online': '在线',
    'status-idle': '空闲',
    'status-dnd': '请勿打扰',
    'status-invisible': '隐身',
    'activity-playing': '玩',
    'activity-streaming': '直播',
    'activity-listening': '听',
    'activity-watching': '看',
    'activity-none': '无',
    'activity-competing': '竞争',
    'language-tooltip': '语言可能是机器翻译的。',
    'no-state-data': '没有状态数据。',
    help: '帮助'
    // ... more Simplified Chinese strings
  },
  ko: {
    'send-webhook': 'Discord Webhook 보내기',
    'webhook-url': 'Webhook URL',
    name: '이름',
    avatar: '아바타 URL',
    message: '메시지',
    send: '보내기',
    bot: '봇',
    'message-placeholder': '여기에 메시지를 입력하세요',
    token: '토큰',
    login: '로그인',
    logout: '로그아웃',
    invite: '초대',
    status: '상태',
    activity: '활동',
    'status-details': '상태 세부 정보',
    'status-details-placeholder': '여기에 상태 세부 정보를 입력하세요',
    'twitch-url': 'Twitch.tv URL',
    'update-status': '상태 업데이트',
    settings: '설정',
    theme: '테마',
    'show-token': '토큰 표시',
    language: '언어',
    about: '정보',
    'bot-state': '봇 상태',
    value: '값',
    'run-code': '코드 실행',
    'run-code-placeholder': '여기에 JavaScript 코드를 입력하세요...',
    output: '출력',
    run: '실행',
    stats: '통계',
    users: '사용자',
    'messages-sent': '보낸 메시지',
    'messages-received': '받은 메시지',
    'on-join': '참여 시',
    'on-leave': '떠날 때',
    'on-ban': '차단 시',
    'private-messages-received': '받은 개인 메시지',
    servers: '서버',
    commands: '명령어',
    'time-spent-in-app': '앱에서 보낸 시간',
    'webhooks-sent': '보낸 Webhook',
    cancel: '취소',
    'add-command': '명령어 추가',
    'no-commands-found': '명령어를 찾을 수 없습니다.',
    'command-exported-to-clipboard': '명령어가 클립보드에 내보내졌습니다!',
    delete: '삭제',
    'are-you-sure-you-want-to-delete-the-command': '명령어를 삭제하시겠습니까?',
    'open-quote': '“',
    'close-quote': '”',
    'edit-command': '명령어 편집',
    'choose-command-type': '명령어 유형 선택',
    'message-received': '메시지 수신',
    'private-message-received': '개인 메시지 수신',
    'member-join': '회원 가입',
    'member-leave': '회원 탈퇴',
    'member-ban': '회원 차단',
    reaction: '반응',
    command: '명령어',
    description: '설명',
    'reaction-placeholder': '이모지 ID 또는 이름 또는 😊',
    'specific-message-only': '특정 메시지만',
    'message-id': '메시지 ID',
    phrase: '구문',
    'requires-role': '역할 필요',
    'required-role': '필요한 역할',
    'role-id': '역할 ID',
    'requires-admin': '관리자 필요',
    'send-message': '메시지 보내기',
    'channel-message': '채널 메시지',
    'send-channel-embed': '채널 임베드 보내기',
    'channel-embed-title': '채널 임베드 제목',
    'channel-embed-description': '채널 임베드 설명',
    'channel-embed-footer': '채널 임베드 바닥글',
    'channel-embed-image': '채널 임베드 이미지',
    'channel-embed-thumbnail': '채널 임베드 썸네일',
    'channel-embed-color': '채널 임베드 색상',
    'is-specific-channel': '특정 채널입니다',
    'specific-channel': '특정 채널',
    'send-private-message': '개인 메시지 보내기',
    'private-message': '개인 메시지',
    'send-private-embed': '개인 임베드 보내기',
    'private-embed-title': '개인 임베드 제목',
    'private-embed-description': '개인 임베드 설명',
    'private-embed-footer': '개인 임베드 바닥글',
    'private-embed-image': '개인 임베드 이미지',
    'private-embed-thumbnail': '개인 임베드 썸네일',
    'private-embed-color': '개인 임베드 색상',
    'react-to-message': '메시지에 반응',
    'ignore-error-message': '오류 메시지 무시',
    'delete-if-contains': '포함 시 삭제',
    'delete-if-strings': '문자열 시 삭제',
    'delete-after': '후에 삭제',
    'delete-x-times': 'X번 삭제',
    'delete-num': '삭제 수',
    'is-nsfw': 'NSFW입니다',
    moderation: '관리',
    kick: '추방',
    ban: '차단',
    'voice-mute': '음성 음소거',
    'role-assigner': '역할 할당자',
    'role-to-assign': '할당할 역할',
    'update-command': '명령어 업데이트',
    action: '동작',
    hours: '시간',
    minutes: '분',
    seconds: '초',
    'status-online': '온라인',
    'status-idle': '아이들',
    'status-dnd': '노키즈 디스트럭트',
    'status-invisible': '인비저블',
    'activity-playing': '플레이',
    'activity-streaming': '스트리밍',
    'activity-listening': '리스닝',
    'activity-watching': '워치',
    'activity-none': '노',
    'activity-competing': '경쟁',
    'language-tooltip': '언어는 자동 번역일 수 있습니다.',
    'no-state-data': '상태 데이터가 없습니다.',
    help: '도움말'
    // ... more Korean strings
  },
  ru: {
    'send-webhook': 'Отправить Discord Webhook',
    'webhook-url': 'URL вебхука',
    name: 'Имя',
    avatar: 'URL аватара',
    message: 'Сообщение',
    send: 'Отправить',
    bot: 'Бот',
    'message-placeholder': 'Введите ваше сообщение здесь',
    token: 'Токен',
    login: 'Войти',
    logout: 'Выйти',
    invite: 'Пригласить',
    status: 'Статус',
    activity: 'Активность',
    'status-details': 'Детали статуса',
    'status-details-placeholder': 'Введите детали вашего статуса здесь',
    'twitch-url': 'URL Twitch.tv',
    'update-status': 'Обновить статус',
    settings: 'Настройки',
    theme: 'Тема',
    'show-token': 'Показать токен',
    language: 'Язык',
    about: 'О программе',
    'bot-state': 'Состояние бота',
    value: 'Значение',
    'run-code': 'Запустить код',
    'run-code-placeholder': 'Введите JavaScript код здесь...',
    output: 'Вывод',
    run: 'Запустить',
    stats: 'Статистика',
    users: 'Пользователи',
    'messages-sent': 'Отправлено сообщений',
    'messages-received': 'Получено сообщений',
    'on-join': 'При присоединении',
    'on-leave': 'При выходе',
    'on-ban': 'При бане',
    'private-messages-received': 'Получено личных сообщений',
    servers: 'Серверы',
    commands: 'Команды',
    'time-spent-in-app': 'Время в приложении',
    'webhooks-sent': 'Отправлено вебхуков',
    cancel: 'Отмена',
    'add-command': 'Добавить команду',
    'no-commands-found': 'Команды не найдены.',
    'command-exported-to-clipboard': 'Команда экспортирована в буфер обмена!',
    delete: 'Удалить',
    'are-you-sure-you-want-to-delete-the-command': 'Вы уверены, что хотите удалить команду?',
    'open-quote': '«',
    'close-quote': '»',
    'edit-command': 'Редактировать команду',
    'choose-command-type': 'Выберите тип команды',
    'message-received': 'Сообщение получено',
    'private-message-received': 'Личное сообщение получено',
    'member-join': 'Участник присоединился',
    'member-leave': 'Участник покинул',
    'member-ban': 'Участник забанен',
    reaction: 'Реакция',
    command: 'Команда',
    description: 'Описание',
    'reaction-placeholder': 'ID или имя эмодзи или 😊',
    'specific-message-only': 'Только конкретное сообщение',
    'message-id': 'ID сообщения',
    phrase: 'Фраза',
    'requires-role': 'Требуется роль',
    'required-role': 'Требуемая роль',
    'role-id': 'ID роли',
    'requires-admin': 'Требуется администратор',
    'send-message': 'Отправить сообщение',
    'channel-message': 'Сообщение канала',
    'send-channel-embed': 'Отправить встраивание канала',
    'channel-embed-title': 'Заголовок встраивания канала',
    'channel-embed-description': 'Описание встраивания канала',
    'channel-embed-footer': 'Нижний колонтитул встраивания канала',
    'channel-embed-image': 'Изображение встраивания канала',
    'channel-embed-thumbnail': 'Миниатюра встраивания канала',
    'channel-embed-color': 'Цвет встраивания канала',
    'is-specific-channel': 'Это конкретный канал',
    'specific-channel': 'Конкретный канал',
    'send-private-message': 'Отправить личное сообщение',
    'private-message': 'Личное сообщение',
    'send-private-embed': 'Отправить личное встраивание',
    'private-embed-title': 'Заголовок личного встраивания',
    'private-embed-description': 'Описание личного встраивания',
    'private-embed-footer': 'Нижний колонтитул личного встраивания',
    'private-embed-image': 'Изображение личного встраивания',
    'private-embed-thumbnail': 'Миниатюра личного встраивания',
    'private-embed-color': 'Цвет личного встраивания',
    'react-to-message': 'Реагировать на сообщение',
    'ignore-error-message': 'Игнорировать сообщение об ошибке',
    'delete-if-contains': 'Удалить, если содержит',
    'delete-if-strings': 'Удалить, если строки',
    'delete-after': 'Удалить после',
    'delete-x-times': 'Удалить X раз',
    'delete-num': 'Удалить количество',
    'is-nsfw': 'Это NSFW',
    moderation: 'Модерация',
    kick: 'Кик',
    ban: 'Бан',
    'voice-mute': 'Отключить голос',
    'role-assigner': 'Назначение роли',
    'role-to-assign': 'Роль для назначения',
    'update-command': 'Обновить команду',
    action: 'Действие',
    hours: 'ч',
    minutes: 'мин',
    seconds: 'с',
    'status-online': 'Онлайн',
    'status-idle': 'Игра',
    'status-dnd': 'Не беспокоить',
    'status-invisible': 'Невидимый',
    'activity-playing': 'Игра',
    'activity-streaming': 'Стрим',
    'activity-listening': 'Слушать',
    'activity-watching': 'Смотреть',
    'activity-none': 'Ничего',
    'activity-competing': 'Соревнование',
    'language-tooltip': 'Язык может быть машинным переводом.',
    'no-state-data': 'Нет данных о состоянии.',
    help: 'Помощь'
    // ... more Russian strings
  }
  // ... more languages
}

// Create a writable store for the current language
export const currentLanguage = writable(DEFAULT_LANGUAGE)

// Create a derived store for the translation function
export const t = derived(currentLanguage, ($currentLanguage) => (key: string) => {
  // Try to get the string in the current language
  const translation = translations[$currentLanguage]?.[key]
  if (translation) return translation

  // Fallback to English if the string doesn't exist in the current language
  const fallback = translations[DEFAULT_LANGUAGE]?.[key]
  if (fallback) return fallback

  // Return the key itself if no translation is found
  return key
})

// Function to change the current language
export const setLanguage = (language: string) => {
  if (translations[language]) {
    currentLanguage.set(language)
  }
}
