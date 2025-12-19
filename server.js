const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper function to read/write data
const getFilePath = (filename) => path.join(DATA_DIR, `${filename}.json`);

const readData = (filename) => {
    const filePath = getFilePath(filename);
    if (!fs.existsSync(filePath)) return [];
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`Error reading ${filename}:`, err);
        return [];
    }
};

const writeData = (filename, data) => {
    try {
        fs.writeFileSync(getFilePath(filename), JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`Error writing ${filename}:`, err);
    }
};

const saveRoom = (roomData) => {
    writeData(roomData.id, roomData);
};

const getRoom = (roomId) => {
    try {
        const data = readData(roomId);
        if (Object.keys(data).length === 0) return null;
        return data;
    } catch (e) {
        return null;
    }
};

// --- Routes ---

app.get('/', (req, res) => {
    res.render('index', { title: 'Secret Santa' });
});

app.post('/crear-sala', (req, res) => {
    const { nombreGrupo, fechaMaxima, precioMaximo } = req.body;
    const roomId = uuidv4();

    const newRoom = {
        id: roomId,
        name: nombreGrupo,
        maxDate: fechaMaxima,
        maxPrice: precioMaximo,
        participants: [],
        matches: [],
        drawStatus: 'pending',
        createdAt: new Date().toISOString()
    };

    saveRoom(newRoom);
    res.redirect(`/compartir/${roomId}`);
});

app.get('/compartir/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = getRoom(roomId);
    if (!room) return res.status(404).send('Sala no encontrada');

    const host = `${req.protocol}://${req.get('host')}`;

    res.render('share', {
        title: 'Sala Creada',
        roomId,
        roomName: room.name,
        links: {
            join: `${host}/unirse/${roomId}`,
            list: `${host}/lista/${roomId}`,
            draw: `${host}/sorteo/${roomId}`
        }
    });
});

app.get('/unirse/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = getRoom(roomId);
    if (!room) return res.status(404).send('Sala no encontrada');

    const cookieName = `secretSantaUser_${roomId}`;
    const userId = req.cookies[cookieName];

    // If already joined, redirect to list or sorteo depending on status
    if (userId && room.participants.find(p => p.id === userId)) {
        if (room.drawStatus === 'completed') {
            return res.redirect(`/sorteo/${roomId}`);
        }
        return res.redirect(`/lista/${roomId}`);
    }

    res.render('unirse', { title: 'Unirse al Grupo', roomId, roomName: room.name });
});

app.post('/unirse/:roomId', (req, res) => {
    const { roomId } = req.params;
    const { name, giftHint } = req.body;
    const room = getRoom(roomId);

    if (!room) return res.status(404).send('Sala no encontrada');

    // Check if already joined (simple cookie check before logic)
    const cookieName = `secretSantaUser_${roomId}`;
    if (req.cookies[cookieName] && room.participants.find(p => p.id === req.cookies[cookieName])) {
        return res.redirect(`/lista/${roomId}`);
    }

    // Validate registration closed logic if needed, but per requirement "la cookie se encarga"
    if (room.drawStatus === 'completed') {
        return res.status(400).send('El sorteo ya ha sido realizado. No puedes unirte.');
    }

    const userId = uuidv4();
    const newParticipant = {
        id: userId,
        name,
        giftHint
    };

    room.participants.push(newParticipant);
    saveRoom(room);

    res.cookie(cookieName, userId, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.redirect(`/lista/${roomId}`);
});

app.get('/lista/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = getRoom(roomId);
    if (!room) return res.status(404).send('Sala no encontrada');

    const cookieName = `secretSantaUser_${roomId}`;
    const userId = req.cookies[cookieName];
    const isParticipant = !!(userId && room.participants.find(p => p.id === userId));

    res.render('lista', {
        title: 'Lista de Participantes',
        room,
        isParticipant
    });
});

app.get('/sorteo/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = getRoom(roomId);
    if (!room) return res.status(404).send('Sala no encontrada');

    const cookieName = `secretSantaUser_${roomId}`;
    const userId = req.cookies[cookieName];
    const participant = room.participants.find(p => p.id === userId);

    let userMatch = null;
    if (room.drawStatus === 'completed' && participant) {
        const matchEntry = room.matches.find(m => m.giverId === userId);
        if (matchEntry) {
            const receiver = room.participants.find(p => p.id === matchEntry.receiverId);
            if (receiver) {
                userMatch = {
                    name: receiver.name,
                    giftHint: receiver.giftHint
                };
            }
        }
    }

    res.render('sorteo', {
        title: 'Sorteo',
        room,
        participant,
        userMatch
    });
});

app.post('/sorteo/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = getRoom(roomId);

    if (!room) return res.status(404).send('Sala no encontrada');
    if (room.drawStatus === 'completed') return res.redirect(`/sorteo/${roomId}`);
    if (room.participants.length < 2) return res.status(400).send('No hay suficientes participantes');

    // Matching Algorithm
    let givers = [...room.participants];
    let receivers = [...room.participants];
    let isValid = false;

    // Retry until no one gifts themselves
    while (!isValid) {
        // Simple shuffle
        for (let i = receivers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [receivers[i], receivers[j]] = [receivers[j], receivers[i]];
        }
        isValid = givers.every((giver, i) => giver.id !== receivers[i].id);
    }

    room.matches = givers.map((giver, i) => ({
        giverId: giver.id,
        receiverId: receivers[i].id
    }));

    room.drawStatus = 'completed';
    saveRoom(room);

    res.redirect(`/sorteo/${roomId}`);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', dataDir: DATA_DIR });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
