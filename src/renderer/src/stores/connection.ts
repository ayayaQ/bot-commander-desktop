import { writable } from "svelte/store";

export type ConnectionState = {
    connected: boolean;
    username: string;
    avatar: string;
    token: string;
}

function emptyState(): ConnectionState {
    return {
        connected: false,
        username: "",
        avatar: "",
        token: "",
    }
}

function createConnectionStore() {
    const { subscribe, set, update } = writable<ConnectionState>(emptyState());

    const ipc = {
        connect,
        disconnect,
        generateInvite,
        getToken
    }
    
    return {
        subscribe,
        set,
        update,
        ipc
    }
}

export const connectionStore = createConnectionStore();

function addConnectionListener() {
    (window as any).electron.ipcRenderer.on('connect', (event, data) => {
        console.log('Connected to server', data, event);

        connectionStore.update(state => ({
            ...state,
            connected: true,
            username: data.user,
            avatar: data.avatar
        }));
    });

    (window as any).electron.ipcRenderer.on('disconnect', (event) => {
        console.log('Disconnected from server', event);
    });
}

addConnectionListener();

function connect(token: string) {
    (window as any).electron.ipcRenderer.send('connect', token);

    connectionStore.update(state => ({
        ...state,
        token: token
    }));
}

function disconnect() {
    (window as any).electron.ipcRenderer.send('disconnect');

    connectionStore.set(emptyState());
}

async function generateInvite() {
    return await (window as any).electron.ipcRenderer.invoke('generate-invite');
}

async function getToken() {
    return await (window as any).electron.ipcRenderer.invoke('get-token');
}
