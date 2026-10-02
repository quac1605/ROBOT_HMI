/**
 * backend/src/auth/passport.js
 * 
 * CẤU HÌNH PASSPORT LOCAL STRATEGY VỚI ARGON2 (M5 / F5.1).
 */
import { Passport } from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import argon2 from 'argon2';

export function createPassportInstance({ users, dummyHash }) {
    const passport = new Passport();

    passport.use(new LocalStrategy(async (username, password, done) => {
        try {
            const user = await users.findByUsername(username);
            // Dù user không tồn tại, vẫn chạy argon2.verify với dummyHash để thời gian phản hồi đồng đều
            const matches = await argon2.verify(user?.passwordHash ?? dummyHash, password);
            if (!user?.enabled || !matches) {
                return done(null, false, { message: 'Tài khoản hoặc mật khẩu không chính xác' });
            }
            // Tuyệt đối không đưa passwordHash vào user object của session
            return done(null, { id: user.id, username: user.username });
        } catch (error) {
            return done(error);
        }
    }));

    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await users.findEnabledById(id);
            done(null, user || false);
        } catch (error) {
            done(error);
        }
    });

    return passport;
}
