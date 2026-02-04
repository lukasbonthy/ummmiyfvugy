const WebSocket = require("ws");
const http = require("http");

const upstream = "wss://PromiseLand-CKMC.eagler.host/";

const server = http.createServer();

const wss = new WebSocket.Server({ server });

wss.on("connection", (client, req) => {

    const target = new WebSocket(upstream, {
        headers: {
            "Origin": req.headers.origin || "",
            "User-Agent": req.headers["user-agent"] || ""
        }
    });

    target.on("open", () => {

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

    });

    client.on("close", () => target.close());
    target.on("close", () => client.close());
});

server.listen(process.env.PORT || 10000);
