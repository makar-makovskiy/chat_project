import express, {Application} from 'express';
import http, { Server } from 'http';
import {Server as IOServer} from 'socket.io';
import cors from 'cors';
import { PrismaClient } from './generated/prisma';

const newPrsm = new PrismaClient();

class SocketServer {
    private app: Application;
    private httpServer: Server;
    private io: IOServer;
    private readonly port: number = 3000;
    private allRooms: Set<string> = new Set(['Technology', 'Cars', 'Games']);
    
    constructor(port?: number){
        this.port = port || Number(process.env.PORT);
        this.app = express();
        this.httpServer = http.createServer(this.app);
        this.io = new IOServer(this.httpServer, {
            cors: {
                origin: "*",
                methods: ['GET', "POST"]
            }
        });
        this.app.use(cors());

        this.configureRoutes();
        this.configureSocketEvents();
    }

    private configureRoutes() {
        this.app.get('/', (req, res) => res.send("Hello"));
    }

    private configureSocketEvents() {
        this.io.on('connection', (socket) => {
            console.log('connection', socket.id);

            const typingTimers = new Map<string, NodeJS.Timeout>();

            socket.on('disconnect', async () => {
                console.log('disconnect', socket.id);
                try {
                    const user = await newPrsm.user.findFirst({
                        where: { now_room: { not: "вышел" } }
                    });
                    if (user) {
                        await newPrsm.user.update({
                            where: { user_id: user.user_id },
                            data: { status: "offline" }
                        });
                        
                        socket.broadcast.emit('userStatusChanged', {
                            user_id: user.user_id,
                            status: "offline",
                            room: user.now_room
                        });
                    }
                } catch (err) {
                    console.log("Ошибка при дисконнекте", err);
                }
            });

            socket.on('login', async (data: { userId: string; roomName: string }) => {
                try {
                    const { userId, roomName } = data;
                    
                    const rooms = Array.from(socket.rooms);
                    rooms.forEach(room => {
                        if (room !== socket.id) {
                            socket.leave(room);
                            console.log(`Пользователь ${userId} вышел из комнаты ${room}`);
                        }
                    });
            
                    if (!this.allRooms.has(roomName)) {
                        this.allRooms.add(roomName);
                        console.log("Создана новая комната:", roomName);
                    }
            
                    socket.join(roomName);
                    
                   
                    const usersInRoom = await newPrsm.user.findMany({
                        where: { 
                            now_room: roomName,
                            NOT: { status: "offline" }
                        }
                    });
                    
                    let role = 1;
                    if (usersInRoom.length === 0) {
                        role = 2;
                    }
                    
                    const user = await newPrsm.user.upsert({
                        where: { user_id: userId },
                        update: { 
                            status: "online",
                            now_room: roomName,
                            role: role
                        },
                        create: { 
                            user_id: userId, 
                            status: "online",
                            now_room: roomName,
                            role: role,
                            is_muted: false
                        }
                    });
                    
                    const roomHistory = await newPrsm.message.findMany({
                        where: { room: roomName },
                        orderBy: { created_at: 'asc' },
                        take: 50,
                        include: { user: true }
                    });
                    
                    socket.emit('roomHistory', roomHistory);
                    
                    socket.emit('joinedRoom', { 
                        roomName, 
                        message: `Вы присоединились к комнате ${roomName}`,
                        role: user.role,
                        isMuted: user.is_muted
                    });
            
                    socket.to(roomName).emit('roomMessage', {
                        room: roomName,
                        message: `Пользователь ${userId} присоединился к комнате`
                    });

                    console.log("Пользователь зарегистрирован", userId, "в комнате", roomName, "роль:", user.role);
            
                    socket.broadcast.emit("userStatusChanged", {
                        user_id: user.user_id,
                        status: user.status,
                        current_room: user.now_room,
                        role: user.role,
                        is_muted: user.is_muted,
                        created_at: user.created_at
                    });

                    const roomUsers = await newPrsm.user.findMany({
                        where: { 
                            now_room: roomName,
                            status: { in: ["online", "typing"] }
                        }
                    });

                    socket.emit('roomUsers', roomUsers.map(user => ({
                        user_id: user.user_id,
                        status: user.status,
                        role: user.role,
                        is_muted: user.is_muted
                    })));

                } catch (err) {
                    console.log("Ошибка авторизации", err);
                }
            });

            socket.on('userMessage', async (data: {message: string; userId: string }) => {
                try {
                    const roomName = Array.from(socket.rooms).find(room => room !== socket.id);
                    if (!roomName) return;

                   
                    const user = await newPrsm.user.findUnique({
                        where: { user_id: data.userId }
                    });

                    if (user?.is_muted) {
                        socket.emit('errorMessage', {
                            message: 'Вы замьючены и не можете отправлять сообщения'
                        });
                        return;
                    }

                    const message = await newPrsm.message.create({
                        data: {
                            user_id: data.userId,
                            room: roomName,
                            text: data.message
                        },
                        include: {
                            user: true
                        }
                    });

                    this.io.to(roomName).emit('userMessage', {
                        message: data.message,
                        name: data.userId,
                        timestamp: message.created_at
                    });

                    await newPrsm.user.update({
                        where: { user_id: data.userId },
                        data: { status: "online" }
                    });

                    socket.broadcast.emit('userStatusChanged', {
                        user_id: user.user_id,
                        status: user.status,
                        role: user.role,
                        is_muted: user.is_muted,
                        room: user.now_room
                    });
                } catch (err) {
                    console.log("Ошибка отправки сообщения", err);
                }
            });

           
            socket.on('muteUser', async (data: { targetUserId: string; moderatorId: string }) => {
                try {
                    const moderator = await newPrsm.user.findUnique({
                        where: { user_id: data.moderatorId }
                    });

                   
                    if (moderator?.role !== 2) {
                        socket.emit('errorMessage', {
                            message: 'У вас нет прав модератора'
                        });
                        return;
                    }

                    await newPrsm.user.update({
                        where: { user_id: data.targetUserId },
                        data: { is_muted: true }
                    });

                  
                    const roomName = moderator.now_room;
                    this.io.to(roomName).emit('roomMessage', {
                        room: roomName,
                        message: `Пользователь ${data.targetUserId} замьючен`
                    });

                   
                    this.io.to(roomName).emit('userMuted', {
                        userId: data.targetUserId,
                        muted: true
                    });

                } catch (err) {
                    console.log("Ошибка при муте пользователя", err);
                }
            });

            socket.on('unmuteUser', async (data: { targetUserId: string; moderatorId: string }) => {
                try {
                    const moderator = await newPrsm.user.findUnique({
                        where: { user_id: data.moderatorId }
                    });

                   
                    if (moderator?.role !== 2) {
                        socket.emit('errorMessage', {
                            message: 'У вас нет прав модератора'
                        });
                        return;
                    }

                    await newPrsm.user.update({
                        where: { user_id: data.targetUserId },
                        data: { is_muted: false }
                    });

                   
                    const roomName = moderator.now_room;
                    this.io.to(roomName).emit('roomMessage', {
                        room: roomName,
                        message: `Пользователь ${data.targetUserId} размьючен`
                    });

                    
                    this.io.to(roomName).emit('userMuted', {
                        userId: data.targetUserId,
                        muted: false
                    });

                } catch (err) {
                    console.log("Ошибка при размуте пользователя", err);
                }
            });

            socket.on('kickUser', async (data: { targetUserId: string; moderatorId: string }) => {
                try {
                    const moderator = await newPrsm.user.findUnique({
                        where: { user_id: data.moderatorId }
                    });

                   
                    if (moderator?.role !== 2) {
                        socket.emit('errorMessage', {
                            message: 'У вас нет прав модератора'
                        });
                        return;
                    }

                    const targetUser = await newPrsm.user.findUnique({
                        where: { user_id: data.targetUserId }
                    });

                    if (!targetUser) return;

                   
                    await newPrsm.user.update({
                        where: { user_id: data.targetUserId },
                        data: { 
                            status: "offline",
                            now_room: "вышел"
                        }
                    });

                 
                    const roomName = moderator.now_room;
                    this.io.to(roomName).emit('roomMessage', {
                        room: roomName,
                        message: `Пользователь ${data.targetUserId} был исключен из комнаты`
                    });

                   
                    this.io.to(roomName).emit('userKicked', {
                        userId: data.targetUserId
                    });

                
                    socket.broadcast.emit('userStatusChanged', {
                        user_id: targetUser.user_id,
                        status: "offline",
                        role: targetUser.role,
                        is_muted: targetUser.is_muted,
                        current_room: "вышел"
                    });

                } catch (err) {
                    console.log("Ошибка при кике пользователя", err);
                }
            });

            socket.on('typing', async (data: { userId: string; isTyping: boolean }) => {
                try {
                    const { userId, isTyping } = data;
                    
                    if (typingTimers.has(userId)) {
                        clearTimeout(typingTimers.get(userId));
                        typingTimers.delete(userId);
                    }

                    let newStatus = "online";
                    
                    if (isTyping) {
                        newStatus = "typing";
                        const timer = setTimeout(async () => {
                            const user = await newPrsm.user.update({
                                where: { user_id: userId },
                                data: { status: "online" }
                            });
                            
                            socket.broadcast.emit('userStatusChanged', {
                                user_id: user.user_id,
                                status: user.status,
                                role: user.role,
                                is_muted: user.is_muted,
                                room: user.now_room
                            });
                            
                            typingTimers.delete(userId);
                        }, 2000);
                        
                        typingTimers.set(userId, timer);
                    }

                    const user = await newPrsm.user.update({
                        where: { user_id: userId },
                        data: { status: newStatus }
                    });

                    socket.broadcast.emit('userStatusChanged', {
                        user_id: user.user_id,
                        status: user.status,
                        role: user.role,
                        is_muted: user.is_muted,
                        room: user.now_room
                    });

                } catch (err) {
                    console.log("Ошибка обновления статуса typing", err);
                }
            });

            socket.on('logout', async (user_id: string) => {
                try {
                    const user = await newPrsm.user.update({
                        where: { user_id },
                        data: { 
                            status: "offline",
                            now_room: "вышел"
                        }
                    });
                    
                    console.log("Пользователь вышел", user_id);

                    const rooms = Array.from(socket.rooms);
                    rooms.forEach(room => {
                        if (room !== socket.id) {
                            socket.leave(room);
                            socket.to(room).emit('roomMessage', {
                                room: room,
                                message: `Пользователь ${user_id} покинул комнату`
                            });
                        }
                    });

                    socket.broadcast.emit('userStatusChanged', {
                        user_id: user.user_id,
                        status: user.status,
                        role: user.role,
                        is_muted: user.is_muted,
                        current_room: user.now_room,
                        created_at: user.created_at
                    });
                } catch (err) {
                    console.log("Ошибка выхода", err);
                }
            });

            socket.on('sendToRoom', (data: { room: string; message: string }) => {
                socket.to(data.room).emit('roomMessage', {
                    room: data.room,
                    message: data.message,
                    from: socket.id
                });
            });
        });
    }

    public start() {
        this.httpServer.listen(
            this.port, 
            () => console.log(`Listening at: ${this.port}`)
        );
    }
}

new SocketServer(3000).start();