const WebSocket = require("ws");

const upstream = "wss://PromiseLand-CKMC.eagler.host/";

const server = new WebSocket.Server({ port: process.env.PORT || 10000 });

server.on("connection", (client) => {
    const target = new WebSocket(upstream);

    client.on("message", (msg) => {
        if (target.readyState === WebSocket.OPEN) {
            target.send(msg);
        }
    });

    target.on("message", (msg) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });

    client.on("close", () => target.close());
    target.on("close", () => client.close());
});
