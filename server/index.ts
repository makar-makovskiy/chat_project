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

            socket.on('disconnect', () => {
                console.log('disconnect', socket.id);
            });

            socket.on('login', async (data: { userId: string; roomName: string }) => {
                try {
                    const { userId, roomName } = data;
                    
                    if (!this.allRooms.has(roomName)) {
                        this.allRooms.add(roomName);

                        console.log("Создана новая комната:", roomName);
                    }

                    const rooms = Array.from(socket.rooms);
                    rooms.forEach(room => {
                        if (room !== socket.id) {
                            socket.leave(room);
                        }
                    });

                    socket.join(roomName);
                    
                    socket.emit('joinedRoom', { 
                        roomName, 
                        message: `Вы присоединились к комнате ${roomName}` 
                    });

                    socket.to(roomName).emit('roomMessage', {
                        room: roomName,
                        message: `Пользователь ${userId} присоединился к комнате`
                    });

                    const user = await newPrsm.user.upsert({
                        where: { user_id: userId },
                        update: { 
                            online: true,
                            now_room: roomName 
                        },
                        create: { 
                            user_id: userId, 
                            online: true,
                            now_room: roomName
                        }
                    });

                    console.log("Пользователь зарегистрирован", userId, "в комнате", roomName);

                    socket.broadcast.emit("userInfo", {
                        user_id: user.user_id,
                        online: user.online,
                        current_room: user.now_room,
                        created_at: user.created_at
                    });

                } catch (err) {
                    console.log("Ошибка авторизации", err);
                }
            });

             socket.on('userMessage', (data: {message: string; userId: string }) => {
                this.io.emit('userMessage', {
                    message: data.message,
                    name: data.userId
                })
            });

            socket.on('logout', async (user_id: string) => {
                try {
                    const user = await newPrsm.user.update({
                        where: { user_id },
                        data: { 
                            online: false,
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

                    socket.broadcast.emit('userInfo', {
                        user_id: user.user_id,
                        online: user.online,
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

            // socket.on('switchRoom', (data: { newRoom: string; oldRoom: string }) => {
            //     socket.leave(data.oldRoom);
            //     socket.join(data.newRoom);
                
            //     socket.emit('joinedRoom', { 
            //         roomName: data.newRoom, 
            //         message: `Вы перешли в комнату ${data.newRoom}` 
            //     });

            //     socket.to(data.oldRoom).emit('roomMessage', {
            //         room: data.oldRoom,
            //         message: `Пользователь покинул комнату`
            //     });

            //     socket.to(data.newRoom).emit('roomMessage', {
            //         room: data.newRoom,
            //         message: `Новый пользователь присоединился к комнате`
            //     });
            // });
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