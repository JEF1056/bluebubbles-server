const { contextBridge, ipcRenderer } = require("electron");

const isAllowedOrigin = () => {
    try {
        return typeof window !== "undefined" && window.location && window.location.origin === "https://accounts.google.com";
    } catch {
        return false;
    }
};

contextBridge.exposeInMainWorld("mm", {
    setVaultSharedKeys: (str, vaultKeys) => {
        if (!isAllowedOrigin()) return Promise.reject(new Error("Unauthorized origin"));
        return ipcRenderer.invoke("gfind-vault-keys", { str, vaultKeys });
    },
    closeView: () => {
        if (!isAllowedOrigin()) return Promise.reject(new Error("Unauthorized origin"));
        return ipcRenderer.invoke("gfind-vault-close");
    }
});
