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
        'are-you-sure-you-want-to-delete-the-command': '¿Estás seguro de que quieres eliminar el comando?',
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
        // ... more Spanish strings
    },
    // ... more languages
}

// Create a writable store for the current language
export const currentLanguage = writable(DEFAULT_LANGUAGE)

// Create a derived store for the translation function
export const t = derived(
    currentLanguage,
    ($currentLanguage) => (key: string) => {
        // Try to get the string in the current language
        const translation = translations[$currentLanguage]?.[key]
        if (translation) return translation

        // Fallback to English if the string doesn't exist in the current language
        const fallback = translations[DEFAULT_LANGUAGE]?.[key]
        if (fallback) return fallback

        // Return the key itself if no translation is found
        return key
    }
)

// Function to change the current language
export const setLanguage = (language: string) => {
    if (translations[language]) {
        currentLanguage.set(language)
    }
}
