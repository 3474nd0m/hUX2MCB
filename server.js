// why do i do this to myself?

const http = require('http')
const express = require('express')
const mineflayer = require('mineflayer')
const { mineflayer: viewerFunc } = require('prismarine-viewer')
const { createProxyMiddleware } = require('http-proxy-middleware')
const net = require('net')

const app = express()
const server = http.createServer(app)

const PORT = process.env.PORT || 3000 // moved him here say hi

const cors = require('cors')
app.use(cors())

app.use(express.json())
app.use('/view', createProxyMiddleware({
    target: 'http://localhost:' + (PORT+1),
    changeOrigin: true,
    ws: true
}))

// ==========================================
// PER-PLAYER STATE
// ==========================================

const bots = {}
const botStatuses = {}
const chatLogs = {}
const lastHosts = {}
const lastPorts = {}
const lastUsernames = {}
const keyStates = {}
const miningLoops = {}
const isDiggings = {}
const intentionalDisconnects = {}
const viewerServers = {}

function getKeys(playerId) {
    if (!keyStates[playerId]) {
        keyStates[playerId] = {
            forward: false, back: false, left: false, right: false,
            jump: false, sprint: false, sneak: false, ctrl: false
        }
    }
    return keyStates[playerId]
}

// ==========================================
// CONNECTION TEST
// ==========================================

function testConnection(host, port, timeout = 5000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port, timeout })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => { socket.destroy(); resolve(false) })
        socket.once('timeout', () => { socket.destroy(); resolve(false) })
    })
}

// ==========================================
// CHAT FORMAT
// ==========================================

function formatMessage(jsonMsg, format = 'roblox') {
    const colorMap = {
        '0': { roblox: '#000000', godot: '000000' },
        '1': { roblox: '#0000AA', godot: '0000AA' },
        '2': { roblox: '#00AA00', godot: '00AA00' },
        '3': { roblox: '#00AAAA', godot: '00AAAA' },
        '4': { roblox: '#AA0000', godot: 'AA0000' },
        '5': { roblox: '#AA00AA', godot: 'AA00AA' },
        '6': { roblox: '#FFAA00', godot: 'FFAA00' },
        '7': { roblox: '#AAAAAA', godot: 'AAAAAA' },
        '8': { roblox: '#555555', godot: '555555' },
        '9': { roblox: '#5555FF', godot: '5555FF' },
        'a': { roblox: '#55FF55', godot: '55FF55' },
        'b': { roblox: '#55FFFF', godot: '55FFFF' },
        'c': { roblox: '#FF5555', godot: 'FF5555' },
        'd': { roblox: '#FF55FF', godot: 'FF55FF' },
        'e': { roblox: '#FFFF55', godot: 'FFFF55' },
        'f': { roblox: '#FFFFFF', godot: 'FFFFFF' },
    }

    const text = jsonMsg.getText ? jsonMsg.getText() : jsonMsg.toString()

    // strip § codes and rebuild with target format
    let result = ''
    let i = 0
    let openTag = false

    while (i < text.length) {
        if (text[i] === '§' && i + 1 < text.length) {
            const code = text[i + 1].toLowerCase()
            if (openTag) {
                result += format === 'godot' ? '[/color]' : '</font>'
                openTag = false
            }
            if (colorMap[code]) {
                const color = colorMap[code][format]
                result += format === 'godot'
                    ? `[color=#${color}]`
                    : `<font color="${colorMap[code].roblox}">`
                openTag = true
            }
            i += 2
        } else {
            result += text[i]
            i++
        }
    }

    if (openTag) {
        result += format === 'godot' ? '[/color]' : '</font>'
    }

    return result
}

// ==========================================
// BOT CREATION
// ==========================================

function createBot(playerId, host, port, username) {
    lastHosts[playerId] = host
    lastPorts[playerId] = port
    lastUsernames[playerId] = username
    console.log(`🤖 [${playerId}] Creating bot: ${host}:${port} as ${username}`)

    const existing = bots[playerId]
    if (existing && typeof existing.quit === 'function') {
        existing.quit()
        bots[playerId] = null
    }

    botStatuses[playerId] = 'connecting'
    chatLogs[playerId] = []
    miningLoops[playerId] = null
    isDiggings[playerId] = false

    const bot = mineflayer.createBot({
        host: host || 'localhost',
        port: port || 25565,
        username: username || 'hURoMCB-nilname',
        version: false,
        auth: 'offline',
        hideErrors: false,
    })

    bots[playerId] = bot

    bot._client.on('session', () => console.log(`🔑 [${playerId}] Session established`))
    bot._client.on('connect', () => console.log(`🔌 [${playerId}] TCP connected`))
    bot._client.on('disconnect', (packet) => console.log(`📦 [${playerId}] Disconnect:`, packet))

    bot.once('spawn', () => {
        botStatuses[playerId] = 'connected'
        console.log(`✅ [${playerId}] Spawned!`)
		try {
			const viewer = viewerFunc(bot, { port: parseInt(PORT)+1, firstPerson: true })
			viewerServers[playerId] = viewer
			console.log('Viewer running!')
		} catch (e) {
			console.log('Viewer failed:', e.message)
		}	

    })

    bot.on('error', (err) => {
        botStatuses[playerId] = 'error'
        console.error(`❌ [${playerId}] Bot error:`, err.message)
    })

    let retryCount = 0
    const MAX_RETRIES = 3

    bot.on('end', (why) => {
        botStatuses[playerId] = 'disconnected'
        console.log(`🔴 [${playerId}] ended, reason:`, why)
        bots[playerId] = null
        miningLoops[playerId] = null
        isDiggings[playerId] = false
        if (viewerServers[playerId]) {
					try {
			viewerServers[playerId].close()
				} catch (e) {}
			viewerServers[playerId] = null
		}
        if (!intentionalDisconnects[playerId] && retryCount < MAX_RETRIES) {
            retryCount++
            setTimeout(() => createBot(playerId, lastHosts[playerId], lastPorts[playerId], lastUsernames[playerId]), 5000)
        } else {
            intentionalDisconnects[playerId] = false
            retryCount = 0
        }
    })

    bot.on('kicked', (reason) => {
        botStatuses[playerId] = 'disconnected'
        console.log(`👢 [${playerId}] Kicked:`, reason)
        bots[playerId] = null
    })

    bot.on('message', (jsonMsg) => {
        const msg = jsonMsg.toString()
        console.log(`💬 [${playerId}]:`, msg)
        if (!chatLogs[playerId]) chatLogs[playerId] = []
        chatLogs[playerId].push(msg)
        if (chatLogs[playerId].length > 50) chatLogs[playerId].shift()
    })
}

// ==========================================
// MOVEMENT LOOP
// ==========================================

setInterval(() => {
    for (const playerId in bots) {
        const bot = bots[playerId]
        if (!bot || botStatuses[playerId] !== 'connected') continue
        const keys = getKeys(playerId)
        try {
            bot.setControlState('forward', keys.forward)
            bot.setControlState('back', keys.back)
            bot.setControlState('left', keys.left)
            bot.setControlState('right', keys.right)
            bot.setControlState('jump', keys.jump)
            bot.setControlState('sprint', keys.sprint)
            bot.setControlState('sneak', keys.sneak)
        } catch (e) {}
    }
}, 50)

// ==========================================
// ROUTES
// ==========================================

app.get('/ping', (req, res) => {
    res.json({ alive: true })
})

app.get('/status', (req, res) => {
    const { playerId } = req.query
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const bot = bots[playerId]
    res.json({
        botStatus: botStatuses[playerId] || 'disconnected',
        health: bot?.health ?? null,
        food: bot?.food ?? null,
        position: bot?.entity?.position ?? null,
        username: bot?.username ?? null
    })
})

app.post('/connect', async (req, res) => {
    const { playerId, host, port, username } = req.body
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    if (!host) return res.status(400).json({ error: 'host required' })

    const reachable = await testConnection(host, port || 25565)
    if (!reachable) return res.status(400).json({ error: 'server unreachable' })

    createBot(playerId, host, port, username)
    res.json({ ok: true, message: 'Bot connecting...' })
})

app.post('/disconnect', (req, res) => {
    const { playerId } = req.body
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    intentionalDisconnects[playerId] = true
    const bot = bots[playerId]
    if (bot && typeof bot.quit === 'function') {
        bots[playerId] = null
        botStatuses[playerId] = 'disconnected'
        bot.on('end', () => {})
        bot.quit()
    }
    res.json({ ok: true })
})

app.post('/key', (req, res) => {
    const { playerId, key, state } = req.body
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const bot = bots[playerId]
    if (!bot || botStatuses[playerId] !== 'connected')
        return res.status(400).json({ error: 'bot not connected' })

    const keys = getKeys(playerId)

    if (keys.hasOwnProperty(key)) keys[key] = state === true

    if (key === 'ctrl') {
        keys.ctrl = state
        keys.sprint = state
    }

    if (key === 'attack' && state === true) {
        miningLoops[playerId] = setInterval(async () => {
            if (isDiggings[playerId]) return
            try {
                const block = bot.blockAtCursor(5)
                const entity = bot.nearestEntity(e => e !== bot.entity && e.type === 'mob')
                const entityDist = entity ? bot.entity.position.distanceTo(entity.position) : Infinity
                const blockDist = block ? bot.entity.position.distanceTo(block.position) : Infinity
                if (entity && entityDist < 5) {
                    bot.attack(entity)
                } else if (block && block.name !== 'air' && blockDist < 5) {
                    isDiggings[playerId] = true
                    await bot.dig(block)
                    isDiggings[playerId] = false
                }
            } catch(e) { isDiggings[playerId] = false }
        }, 100)
    }

    if (key === 'attack' && state === false) {
        if (miningLoops[playerId]) {
            clearInterval(miningLoops[playerId])
            miningLoops[playerId] = null
        }
        isDiggings[playerId] = false
        try { bot.stopDigging() } catch(e) {}
    }

    if (key === 'use' && state === true) bot.activateItem()

    const hotbarMap = {
        One: 0, Two: 1, Three: 2, Four: 3, Five: 4,
        Six: 5, Seven: 6, Eight: 7, Nine: 8
    }
    if (hotbarMap.hasOwnProperty(key) && state === true) {
        bot.setQuickBarSlot(hotbarMap[key])
    }

    if (key === 'drop' && state === true) {
        const item = bot.inventory.slots[bot.quickBarSlot + 36]
        if (!item) { res.json({ ok: true }); return }
        if (keys.ctrl) {
            bot.tossStack(item, () => {})
        } else {
            bot.toss(item.type, null, 1, () => {})
        }
    }

    if (key === 'dropAll' && state === true) {
        const item = bot.inventory.slots[bot.quickBarSlot + 36]
        if (item) bot.tossStack(item, () => {})
    }

    res.json({ ok: true })
})

app.post('/look', (req, res) => {
    const { playerId, yaw, pitch } = req.body
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const bot = bots[playerId]
    if (!bot || botStatuses[playerId] !== 'connected')
        return res.status(400).json({ error: 'bot not connected' })
    bot.look(yaw, pitch, true)
    res.json({ ok: true })
})

app.post('/chat', (req, res) => {
    const { playerId, message } = req.body
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const bot = bots[playerId]
    if (!bot || botStatuses[playerId] !== 'connected')
        return res.status(400).json({ error: 'bot not connected' })
    if (!message) return res.status(400).json({ error: 'message required' })
    bot.chat(message)
    res.json({ ok: true })
})

app.get('/messages', (req, res) => {
    const { playerId, format } = req.query
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const msgs = (chatLogs[playerId] || []).map(msg => formatMessage(msg, format))
    res.json({ messages: msgs })
})

app.get('/inventory', (req, res) => {
    const { playerId } = req.query
    if (!playerId) return res.status(400).json({ error: 'playerId required' })
    const bot = bots[playerId]
    if (!bot || botStatuses[playerId] !== 'connected') return res.json({ slots: [] })
    const slots = bot.inventory.slots.map((item, index) => 
        item ? { name: item.name, count: item.count, slot: index } : null
    ).filter(item => item !== null)
    res.json({ slots })
})

// ==========================================
// START SERVER
// ==========================================

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})
