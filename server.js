const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// 메모리 기반 데이터 저장소 (서버 재시작시 초기화됨)
const memoryDB = {
    users: [],
    trainingRecords: [],
    dailyAttempts: [],
    settings: [],
    stepCompletions: [],
    monthlyRankings: [],
    badges: [],
    titles: [],
    personalGoals: [],
    // 영혼석 시스템
    tokens: [],       // { user_id, amount, updated_at }
    tokenLogs: [],    // { id, user_id, amount, reason, created_at }
    // 뽑기 시스템
    collections: [],  // { user_id, character_id, count, first_obtained_at }
    gachaNews: []     // { id, user_id, username, character_name, grade, obtained_at }
};

let userIdCounter = 1;
let recordIdCounter = 1;
let attemptIdCounter = 1;
let stepCompletionIdCounter = 1;
let rankingIdCounter = 1;
let badgeIdCounter = 1;
let titleIdCounter = 1;
let goalIdCounter = 1;
let tokenLogIdCounter = 1;
let gachaNewsIdCounter = 1; // ✅ 추가
// 쿼리 헬퍼 함수 (메모리 DB용)
async function query(text, params = []) {
    // SELECT 쿼리 시뮬레이션
    if (text.includes('SELECT') && text.includes('FROM users')) {
        if (text.includes("username = $1") || text.includes("username = ?")) {
            const user = memoryDB.users.find(u => u.username === params[0]);
            return { rows: user ? [user] : [] };
        }
        if (text.includes('is_admin = false') || text.includes('is_admin = 0')) {
            return { rows: memoryDB.users.filter(u => !u.is_admin) };
        }
        if (text.includes('WHERE id = $1') || text.includes('WHERE id = ?')) {
            const user = memoryDB.users.find(u => u.id === params[0]);
            return { rows: user ? [user] : [] };
        }
        if (text.includes('username ILIKE') || text.includes('username LIKE')) {
            const searchTerm = params[0].replace(/%/g, '');
            return { rows: memoryDB.users.filter(u => !u.is_admin && u.username.toLowerCase().includes(searchTerm.toLowerCase())) };
        }
    }
    
    if (text.includes('SELECT') && text.includes('FROM settings')) {
        if (text.includes('WHERE key')) {
            const key = params[0];
            const setting = memoryDB.settings.find(s => s.key === key);
            return { rows: setting ? [setting] : [] };
        }
        return { rows: memoryDB.settings };
    }
    
    if (text.includes('SELECT') && text.includes('FROM daily_attempts')) {
        const attempt = memoryDB.dailyAttempts.find(a => a.user_id === params[0] && a.date === params[1]);
        return { rows: attempt ? [attempt] : [] };
    }
    
    // 단계 완료 조회
    if (text.includes('SELECT') && text.includes('FROM step_completions')) {
        if (text.includes('WHERE user_id') && text.includes('AND date')) {
            const completions = memoryDB.stepCompletions.filter(sc => 
                sc.user_id === params[0] && sc.date === params[1]
            );
            return { rows: completions };
        }
        
        if (text.includes('WHERE date')) {
            const completions = memoryDB.stepCompletions.filter(sc => sc.date === params[0]);
            return { rows: completions };
        }
    }
    
    if (text.includes('SELECT') && text.includes('FROM training_records')) {
        if (text.includes('JOIN users')) {
            // 날짜별 조회
            if (text.includes('WHERE tr.date')) {
                const date = params[0];
                const searchUser = params[1] || '';
                let records = memoryDB.trainingRecords.filter(r => r.date === date);
                
                if (searchUser) {
                    records = records.filter(r => {
                        const user = memoryDB.users.find(u => u.id === r.user_id);
                        return user && user.username.toLowerCase().includes(searchUser.toLowerCase());
                    });
                }
                
                return { rows: records.map(r => {
                    const user = memoryDB.users.find(u => u.id === r.user_id);
                    return { ...r, username: user ? user.username : 'Unknown' };
                }) };
            }
            // 사용자별 조회
            if (text.includes('WHERE tr.user_id')) {
                const records = memoryDB.trainingRecords.filter(r => r.user_id === params[0]);
                return { rows: records.map(r => {
                    const user = memoryDB.users.find(u => u.id === r.user_id);
                    return { ...r, username: user ? user.username : 'Unknown' };
                }) };
            }
        }
        
        // 기본 조회
        if (text.includes('WHERE user_id')) {
            let records = memoryDB.trainingRecords.filter(r => r.user_id === params[0]);
            if (text.includes('LIMIT')) {
                records = records.slice(0, 50);
            }
            return { rows: records };
        }
        
        // COUNT 쿼리
        if (text.includes('COUNT(*)')) {
            if (text.includes('is_correct')) {
                const count = memoryDB.trainingRecords.filter(r => r.user_id === params[0] && r.is_correct).length;
                return { rows: [{ correct: count }] };
            }
            if (text.includes('date >=')) {
                const count = memoryDB.trainingRecords.filter(r => r.user_id === params[0] && r.date >= params[1]).length;
                return { rows: [{ recent: count }] };
            }
            const count = memoryDB.trainingRecords.filter(r => r.user_id === params[0]).length;
            return { rows: [{ total: count }] };
        }
    }
    
    // INSERT 쿼리 시뮬레이션
    if (text.includes('INSERT INTO users')) {
        const newUser = {
            id: userIdCounter++,
            username: params[0],
            password: params[1],
            is_admin: params.length > 2 && (params[2] === true || params[2] === 1),
            level: 3,
            status: 'active',
            created_at: new Date().toISOString(),
            last_login: null
        };
        memoryDB.users.push(newUser);
        return { rows: [{ id: newUser.id }] };
    }
    
    if (text.includes('INSERT INTO training_records')) {
        const newRecord = {
            id: recordIdCounter++,
            user_id: params[0],
            actual_count: params[1],
            user_answer: params[2],
            is_correct: params[3],
            level: params[4],
            date: params[5],
            timestamp: params[6],
            difficulty_range: params[7],
            bpm: params[8] || 100,
            score: params[9] || 0,
            answer_type: params[10] || 'wrong'
        };
        memoryDB.trainingRecords.push(newRecord);
        return { rows: [] };
    }
    
    if (text.includes('INSERT INTO daily_attempts')) {
        const newAttempt = {
            id: attemptIdCounter++,
            user_id: params[0],
            date: params[1],
            attempts: params[2] === undefined ? 1 : params[2],
            bonus_attempts: params.length > 2 ? params[2] : 0
        };
        memoryDB.dailyAttempts.push(newAttempt);
        return { rows: [] };
    }
    
    if (text.includes('INSERT') && text.includes('settings')) {
        const existing = memoryDB.settings.find(s => s.key === params[0]);
        if (!existing) {
            const newSetting = {
                key: params[0],
                value: params[1],
                description: params[2],
                updated_by: params[3] || 'system'
            };
            memoryDB.settings.push(newSetting);
        }
        return { rows: [] };
    }
    
    if (text.includes('INSERT INTO step_completions')) {
        const newCompletion = {
            id: stepCompletionIdCounter++,
            user_id: params[0],
            date: params[1],
            step1: params[2] || false,
            step2: params[3] || false,
            step3: params[4] || false,
            step4: params[5] || false,
            step5: params[6] || false,
            completed_at: new Date().toISOString()
        };
        memoryDB.stepCompletions.push(newCompletion);
        return { rows: [] };
    }
    
    // UPDATE 쿼리 시뮬레이션
    if (text.includes('UPDATE users')) {
        if (text.includes('last_login')) {
            const user = memoryDB.users.find(u => u.id === params[0]);
            if (user) user.last_login = new Date().toISOString();
        }
        if (text.includes('SET level')) {
            const user = memoryDB.users.find(u => u.id === params[1]);
            if (user) user.level = params[0];
        }
        if (text.includes('SET password')) {
            const user = memoryDB.users.find(u => u.id === params[1]);
            if (user) user.password = params[0];
        }
        return { rows: [] };
    }
    
    if (text.includes('UPDATE daily_attempts')) {
        if (text.includes('SET attempts')) {
            const attempt = memoryDB.dailyAttempts.find(a => a.user_id === params[0] && a.date === params[1]);
            if (attempt) attempt.attempts++;
        }
        if (text.includes('bonus_attempts')) {
            const attempt = memoryDB.dailyAttempts.find(a => a.user_id === params[0] && a.date === params[1]);
            if (attempt) attempt.bonus_attempts++;
        }
        return { rows: [] };
    }
    
    if (text.includes('UPDATE settings')) {
        const setting = memoryDB.settings.find(s => s.key === params[2]);
        if (setting) {
            setting.value = params[0];
            setting.updated_by = params[1];
        }
        return { rows: [] };
    }
    
    if (text.includes('UPDATE step_completions')) {
        const completion = memoryDB.stepCompletions.find(sc => 
            sc.user_id === params[1] && sc.date === params[2]
        );
        if (completion) {
            const stepNum = params[0];
            completion[`step${stepNum}`] = true;
            completion.completed_at = new Date().toISOString();
        }
        return { rows: [] };
    }
    
    // DELETE 쿼리 시뮬레이션
    if (text.includes('DELETE FROM training_records')) {
        memoryDB.trainingRecords = memoryDB.trainingRecords.filter(r => r.user_id !== params[0]);
        return { rows: [] };
    }
    
    if (text.includes('DELETE FROM daily_attempts')) {
        memoryDB.dailyAttempts = memoryDB.dailyAttempts.filter(a => a.user_id !== params[0]);
        return { rows: [] };
    }
    
    if (text.includes('DELETE FROM users')) {
        memoryDB.users = memoryDB.users.filter(u => u.id !== params[0]);
        return { rows: [] };
    }
    
    return { rows: [] };
}

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'readin-concentration-secret-key-v2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 30 * 60 * 1000  // 30분
    }
}));

// 데이터베이스 초기화
async function initializeDatabase() {
    try {
        console.log('🔧 메모리 데이터베이스 초기화 시작...');
        console.log('⚠️ 경고: 서버 재시작시 모든 데이터가 삭제됩니다!');

        // 관리자 계정 생성
        const hash = await bcrypt.hash('admin123', 10);
        memoryDB.users.push({
            id: userIdCounter++,
            username: 'readin',
            password: hash,
            is_admin: true,
            level: 3,
            status: 'active',
            created_at: new Date().toISOString(),
            last_login: null
        });
        console.log('👑 관리자 계정 생성 완료: readin / admin123');

        // 기본 설정 초기화
        const defaultSettings = [
            { key: 'auto_signup', value: '1', description: '자동 회원가입 허용 여부', updated_by: 'system' },
            { key: 'allow_password_change', value: '0', description: '참가자 비밀번호 변경 허용 여부', updated_by: 'system' },
            { key: 'show_visual_feedback', value: '1', description: '훈련 중 시각적 피드백 표시 여부', updated_by: 'system' }
        ];

        memoryDB.settings = defaultSettings;

        console.log('🎉 메모리 데이터베이스 초기화 완료!');
    } catch (error) {
        console.error('❌ 데이터베이스 초기화 실패:', error);
        process.exit(1);
    }
}

// 자동 배지 수여 함수
async function autoAwardBadges() {
    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    
    const year = kstTime.getFullYear();
    const month = kstTime.getMonth() + 1;
    const day = kstTime.getDate();
    
    // 2026년 3월 이전에는 배지 수여 안 함
    if (year < 2026 || (year === 2026 && month < 3)) {
        return;
    }
    
    // 이번 달 말일 계산
    const lastDay = new Date(year, month, 0).getDate();
    
    // 오늘이 말일이고, 시간이 23:59인 경우
    const hour = kstTime.getHours();
    const minute = kstTime.getMinutes();
    
    if (day === lastDay && hour === 23 && minute === 59) {
        console.log(`\n🎖️ === 자동 배지 수여 시작 (${year}년 ${month}월) ===`);
        
        try {
            const rankings = calculateMonthlyRanking(year, month);
            const targetMonth = `${year}-${String(month).padStart(2, '0')}`;
            
            // 기존 배지 삭제
            memoryDB.badges = memoryDB.badges.filter(b => b.month !== targetMonth);
            
            // 상위 5명에게 배지 수여
            const badgeTypes = [
                { rank: 1, type: 'gold', name: '골드 배지', reward: '5,000원' },
                { rank: 2, type: 'silver', name: '실버 배지', reward: '4,000원' },
                { rank: 3, type: 'bronze', name: '브론즈 배지', reward: '3,000원' },
                { rank: 4, type: 'excellence', name: '우수 배지', reward: '2,000원' },
                { rank: 5, type: 'excellence', name: '우수 배지', reward: '1,000원' }
            ];
            
            // 랭킹 토큰 보상 정의
            const rankingTokens = { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 };

            const rankingStones = { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 };

            badgeTypes.forEach((badge, index) => {
                if (rankings[index]) {
                    memoryDB.badges.push({
                        id: badgeIdCounter++,
                        user_id: rankings[index].user_id,
                        username: rankings[index].username,
                        rank: badge.rank,
                        badge_type: badge.type,
                        badge_name: badge.name,
                        reward: badge.reward,
                        month: targetMonth,
                        awarded_at: new Date().toISOString()
                    });

                    // 랭킹 영혼석 지급
                    const stones = rankingStones[badge.rank] || 0;
                    if (stones > 0) {
                        updateToken(rankings[index].user_id, stones, 'ranking');
                        console.log(`💎 ${badge.rank}위 영혼석 지급: ${rankings[index].username} +${stones}`);
                    }

                    console.log(`🏆 ${badge.rank}위: ${rankings[index].username} - ${badge.badge_name}`);
                }
            });
            
            console.log(`✅ 자동 배지 수여 완료!\n`);
        } catch (error) {
            console.error('❌ 자동 배지 수여 실패:', error);
        }
    }
}

// Helper functions
function getTodayKST() {
    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return kstTime.toISOString().split('T')[0];
}

function getKSTTimestamp() {
    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return kstTime.toISOString().replace('T', ' ').substring(0, 19);
}

function getDaysSinceStart() {
    const startDate = new Date('2025-08-30T00:00:00Z');
    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    
    const kstHour = kstTime.getUTCHours();
    let adjustedKstTime = new Date(kstTime);
    if (kstHour < 9) {
        adjustedKstTime.setUTCDate(adjustedKstTime.getUTCDate() - 1);
    }
    
    const diffTime = adjustedKstTime.getTime() - startDate.getTime();
    return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
}

function getDifficultyRange(level) {
    const days = getDaysSinceStart();
    
    switch(level) {
        case 1:
            const cycle1 = days % 3;
            const base1 = 10 + (cycle1 * 10);
            return { min: base1, max: base1 + 9, range: `${base1}-${base1 + 9}` };
        
        case 2:
            const cycle2 = days % 6;
            const base2 = 10 + (cycle2 * 10);
            return { min: base2, max: base2 + 9, range: `${base2}-${base2 + 9}` };
        
        case 3:
        default:
            const cycle3 = days % 16;
            const base3 = 30 + (cycle3 * 10);
            return { min: base3, max: base3 + 9, range: `${base3}-${base3 + 9}` };
    }
}

function isCorrectAnswer(actual, answer) {
    return Math.abs(actual - answer) <= 1;
}

function isPerfectAnswer(actual, answer) {
    return actual === answer;
}

function getAnswerScore(actual, answer) {
    if (isPerfectAnswer(actual, answer)) {
        return { score: 15, type: 'perfect' };
    } else if (isCorrectAnswer(actual, answer)) {
        return { score: 10, type: 'close' };
    } else {
        return { score: 0, type: 'wrong' };
    }
}

// 월간 랭킹 계산
function calculateMonthlyRanking(year, month) {
    const targetMonth = `${year}-${String(month).padStart(2, '0')}`;
    const users = memoryDB.users.filter(u => !u.is_admin);
    
    const rankings = users.map(user => {
        const userRecords = memoryDB.trainingRecords.filter(r => 
            r.user_id === user.id && r.date.startsWith(targetMonth)
        );
        
        if (userRecords.length === 0) {
            return {
                user_id: user.id,
                username: user.username,
                total_score: 0,
                perfect_count: 0,
                close_count: 0,
                wrong_count: 0,
                total_attempts: 0,
                accuracy: 0,
                month: targetMonth
            };
        }
        
        const perfectCount = userRecords.filter(r => r.answer_type === 'perfect').length;
        const closeCount = userRecords.filter(r => r.answer_type === 'close').length;
        const wrongCount = userRecords.filter(r => r.answer_type === 'wrong').length;
        const totalAttempts = userRecords.length;
        
        const accumulatedScore = (perfectCount * 15) + (closeCount * 10);
        const accuracy = ((perfectCount + closeCount) / totalAttempts) * 100;
        const totalScore = Math.round(accumulatedScore + accuracy);
        
        return {
            user_id: user.id,
            username: user.username,
            total_score: totalScore,
            perfect_count: perfectCount,
            close_count: closeCount,
            wrong_count: wrongCount,
            total_attempts: totalAttempts,
            accuracy: Math.round(accuracy * 10) / 10,
            month: targetMonth
        };
    });
    
    return rankings.sort((a, b) => b.total_score - a.total_score);
}

// 칭호 확인
function checkTitles(userId) {
    const titles = [];
    const user = memoryDB.users.find(u => u.id === userId);
    if (!user) return titles;
    
    // 집중의 달인: 3개월 연속 1위
    const recentMonths = getRecentMonths(3);
    const consecutiveFirst = recentMonths.every(month => {
        const ranking = calculateMonthlyRanking(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]));
        return ranking[0]?.user_id === userId;
    });
    if (consecutiveFirst) {
        titles.push({ title: '집중의 달인', icon: '🏆', description: '3개월 연속 1위' });
    }
    
    // 꾸준이: 한 달 동안 매일 완료 (30일)
    const currentMonth = getTodayKST().substring(0, 7);
    const monthRecords = memoryDB.trainingRecords.filter(r => 
        r.user_id === userId && r.date.startsWith(currentMonth)
    );
    const uniqueDays = new Set(monthRecords.map(r => r.date)).size;
    if (uniqueDays >= 30) {
        titles.push({ title: '꾸준이', icon: '⭐', description: '한 달 매일 완료' });
    }
    
    // 정확왕: 월 정답률 95% 이상
    const ranking = calculateMonthlyRanking(parseInt(currentMonth.split('-')[0]), parseInt(currentMonth.split('-')[1]));
    const userRank = ranking.find(r => r.user_id === userId);
    if (userRank && userRank.accuracy >= 95) {
        titles.push({ title: '정확왕', icon: '🎯', description: '정답률 95% 이상' });
    }
    
    return titles;
}

function getRecentMonths(count) {
    const months = [];
    const now = new Date();
    for (let i = 0; i < count; i++) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
}

// ✅ 캐릭터 데이터
const CHARACTERS = [
    // SSS
    { id: 'sss_1', grade: 'SSS', name: '황룡', color: '#FFD700', description: '세계관의 중심을 지키는 절대자. 모든 속성을 다스리는 유일무이한 존재.' },
    // SS
    { id: 'ss_1', grade: 'SS', name: '해태', color: '#9B59B6', description: '시비곡직을 가리는 정의의 수호수.' },
    { id: 'ss_2', grade: 'SS', name: '피닉스', color: '#9B59B6', description: '영원히 타오르는 불꽃의 화신.' },
    { id: 'ss_3', grade: 'SS', name: '백호', color: '#9B59B6', description: '서쪽을 다스리는 살육과 투쟁의 신수.' },
    // S
    { id: 's_1', grade: 'S', name: '구미호', color: '#3498DB', description: '아홉 개의 꼬리를 가진 영악한 환술사.' },
    { id: 's_2', grade: 'S', name: '그리핀', color: '#3498DB', description: '사자의 몸과 독수리의 날개를 가진 하늘의 제왕.' },
    { id: 's_3', grade: 'S', name: '유니콘', color: '#3498DB', description: '순결한 뿔로 정화의 힘을 쓰는 치유의 영물.' },
    { id: 's_4', grade: 'S', name: '현무', color: '#3498DB', description: '거대한 거북과 뱀이 합쳐진 철벽의 방어수.' },
    { id: 's_5', grade: 'S', name: '켈베로스', color: '#3498DB', description: '지옥의 문을 지키는 머리 세 개 달린 검은 개.' },
    // A
    { id: 'a_1', grade: 'A', name: '전투 코끼리', color: '#27AE60', description: '단단한 갑주를 입은 중장갑 전사.' },
    { id: 'a_2', grade: 'A', name: '그림자 표범', color: '#27AE60', description: '보이지 않는 속도로 적의 뒤를 노리는 암살자.' },
    { id: 'a_3', grade: 'A', name: '왕관 독수리', color: '#27AE60', description: '높은 시야로 전장을 지휘하는 명사수.' },
    { id: 'a_4', grade: 'A', name: '화염 갈기 사자', color: '#27AE60', description: '기세등등한 포효로 아군의 사기를 높이는 리더.' },
    { id: 'a_5', grade: 'A', name: '서리 늑대', color: '#27AE60', description: '냉기를 뿜으며 무리지어 사냥하는 전사.' },
    { id: 'a_6', grade: 'A', name: '강철 뿔 코뿔소', color: '#27AE60', description: '무엇이든 뚫어버리는 돌격 대장.' },
    { id: 'a_7', grade: 'A', name: '환상 나비', color: '#27AE60', description: '가루를 날려 적을 혼란에 빠뜨리는 서포터.' },
    // B
    { id: 'b_1',  grade: 'B', name: '불곰',            color: '#BDC3C7', description: '묵직한 앞발 한 방으로 상황을 정리하는 든든한 전사.' },
    { id: 'b_2',  grade: 'B', name: '사막 여우',        color: '#BDC3C7', description: '뜨거운 모래 위에서도 날렵하게 움직이는 생존의 달인.' },
    { id: 'b_3',  grade: 'B', name: '정찰매',           color: '#BDC3C7', description: '넓은 하늘을 날며 적의 위치를 가장 먼저 알아채는 눈.' },
    { id: 'b_4',  grade: 'B', name: '숲속 사슴',        color: '#BDC3C7', description: '빠른 발과 예민한 감각으로 아군에게 위험을 알리는 전령.' },
    { id: 'b_5',  grade: 'B', name: '훈련된 군견',      color: '#BDC3C7', description: '오랜 훈련으로 명령에 충실하게 움직이는 믿음직한 동료.' },
    { id: 'b_6',  grade: 'B', name: '멧돼지 돌격병',    color: '#BDC3C7', description: '앞만 보고 돌진하는 거칠고 단순한 돌격 요원.' },
    { id: 'b_7',  grade: 'B', name: '약초 캐는 너구리', color: '#BDC3C7', description: '산속 구석구석을 누비며 아군의 회복을 돕는 조력자.' },
    { id: 'b_8',  grade: 'B', name: '바다 거북',        color: '#BDC3C7', description: '단단한 등껍질로 버텨내는 느리지만 꾸준한 수호자.' },
    { id: 'b_9',  grade: 'B', name: '전기 뱀장어',      color: '#BDC3C7', description: '몸에 전기를 띠어 가까이 오는 적을 찌릿하게 만드는 함정.' },
    { id: 'b_10', grade: 'B', name: '산악 염소',        color: '#BDC3C7', description: '험한 산길도 거뜬히 오르는 발 빠른 고지전 전문가.' },
    // C
    { id: 'c_1',  grade: 'C', name: '들쥐',      color: '#95A5A6', description: '작고 빠르게 돌아다니며 이것저것 주워오는 귀여운 심부름꾼.' },
    { id: 'c_2',  grade: 'C', name: '박쥐',      color: '#95A5A6', description: '어두운 곳을 좋아하는 야행성 꼬마 정찰대원.' },
    { id: 'c_3',  grade: 'C', name: '길고양이',  color: '#95A5A6', description: '제멋대로지만 가끔 기분 좋을 때 도움을 주는 자유로운 녀석.' },
    { id: 'c_4',  grade: 'C', name: '시골 강아지', color: '#95A5A6', description: '마냥 신나서 꼬리를 흔드는 아직 훈련이 덜 된 애기.' },
    { id: 'c_5',  grade: 'C', name: '파랑새',    color: '#95A5A6', description: '파란 날개로 하늘을 날지만 전투엔 크게 도움이 안 되는 마스코트.' },
    { id: 'c_6',  grade: 'C', name: '아기 토끼', color: '#95A5A6', description: '폴짝폴짝 뛰어다니는 귀여움 담당. 전투력은 물음표.' },
    { id: 'c_7',  grade: 'C', name: '두더지',    color: '#95A5A6', description: '땅 속을 파고들어 가끔 유용한 것들을 발견해오는 땅굴 전문가.' },
    { id: 'c_8',  grade: 'C', name: '떠돌이 개', color: '#95A5A6', description: '정처 없이 돌아다니다 우연히 팀에 합류한 유랑 멤버.' },
    { id: 'c_9',  grade: 'C', name: '고슴도치',  color: '#95A5A6', description: '건드리면 가시로 찌르지만 평소엔 그냥 굴러다니는 소심쟁이.' },
    { id: 'c_10', grade: 'C', name: '다람쥐',    color: '#95A5A6', description: '먹이를 열심히 모으다 보면 가끔 아이템도 챙겨오는 부지런한 녀석.' },
    { id: 'c_11', grade: 'C', name: '개구리',    color: '#95A5A6', description: '폴짝 뛰는 것 말고는 특기가 없지만 분위기를 살리는 개그 담당.' },
    { id: 'c_12', grade: 'C', name: '까마귀',    color: '#95A5A6', description: '영리하지만 약간 불길한 느낌을 풍기는 수수께끼 새.' },
    { id: 'c_13', grade: 'C', name: '올챙이',    color: '#95A5A6', description: '아직 개구리도 못 된 성장 중인 꼬마. 잠재력은 무한대?' },
    { id: 'c_14', grade: 'C', name: '병아리',    color: '#95A5A6', description: '삐약삐약 울기만 해도 보는 사람을 기분 좋게 만드는 귀염둥이.' },
];

// ✅ 뽑기 확률
const GACHA_RATES = {
    normal: [
        { grade: 'SSS', rate: 0.0005 },
        { grade: 'SS',  rate: 0.01   },
        { grade: 'S',   rate: 0.05   },
        { grade: 'A',   rate: 0.20   },
        { grade: 'B',   rate: 0.30   },
        { grade: 'C',   rate: 0.4395 },
    ],
    duplicate: [
        { grade: 'SSS', rate: 0.001  },
        { grade: 'SS',  rate: 0.02   },
        { grade: 'S',   rate: 0.07   },
        { grade: 'A',   rate: 0.30   },
        { grade: 'B',   rate: 0.30   },
        { grade: 'C',   rate: 0.309  },
    ]
};

const GACHA_COST = 10;

// ✅ 영혼석 잔액 조회
function getTokenBalance(userId) {
    const record = memoryDB.tokens.find(t => t.user_id === userId);
    return record ? record.amount : 0;
}

// ✅ 영혼석 지급/차감
function updateToken(userId, amount, reason) {
    let record = memoryDB.tokens.find(t => t.user_id === userId);
    if (record) {
        record.amount += amount;
        if (record.amount < 0) record.amount = 0;
        record.updated_at = new Date().toISOString();
    } else {
        memoryDB.tokens.push({
            user_id: userId,
            amount: Math.max(0, amount),
            updated_at: new Date().toISOString()
        });
        record = memoryDB.tokens[memoryDB.tokens.length - 1];
    }
    memoryDB.tokenLogs.push({
        id: tokenLogIdCounter++,
        user_id: userId,
        amount,
        reason,
        created_at: new Date().toISOString()
    });
    return record.amount;
}

// ✅ 이름 마스킹 (가운데 글자 → *, 2글자면 뒷글자)
function maskName(name) {
    if (name.length === 2) return name[0] + '*';
    if (name.length >= 3) {
        const mid = Math.floor(name.length / 2);
        return name.slice(0, mid) + '*' + name.slice(mid + 1);
    }
    return name;
}

// ✅ 등급 결정
function rollGrade(rateTable) {
    const rand = Math.random();
    let cumulative = 0;
    for (const entry of rateTable) {
        cumulative += entry.rate;
        if (rand < cumulative) return entry.grade;
    }
    return rateTable[rateTable.length - 1].grade;
}

// ✅ 등급에 맞는 랜덤 캐릭터 선택
function pickCharacterByGrade(grade) {
    const pool = CHARACTERS.filter(c => c.grade === grade);
    return pool[Math.floor(Math.random() * pool.length)];
}

// ✅ 뽑기 1회 실행
function doGacha(userId) {
    const myIds = memoryDB.collections
        .filter(c => c.user_id === userId)
        .map(c => c.character_id);

    const grade = rollGrade(GACHA_RATES.normal);
    let character = pickCharacterByGrade(grade);
    const isDuplicate = myIds.includes(character.id);

    if (isDuplicate) {
        const dupGrade = rollGrade(GACHA_RATES.duplicate);
        character = pickCharacterByGrade(dupGrade);
        updateToken(userId, 1, 'gacha_refund');
        const existing = memoryDB.collections.find(
            c => c.user_id === userId && c.character_id === character.id
        );
        if (existing) {
            existing.count++;
        } else {
            memoryDB.collections.push({
                user_id: userId,
                character_id: character.id,
                count: 1,
                first_obtained_at: new Date().toISOString()
            });
        }
        return { character, isDuplicate: true };
    }

    memoryDB.collections.push({
        user_id: userId,
        character_id: character.id,
        count: 1,
        first_obtained_at: new Date().toISOString()
    });

    if (grade === 'SSS' || grade === 'SS') {
        const user = memoryDB.users.find(u => u.id === userId);
        memoryDB.gachaNews.push({
            id: gachaNewsIdCounter++,
            user_id: userId,
            username: user ? user.username : '???',
            character_id: character.id,
            character_name: character.name,
            grade,
            obtained_at: new Date().toISOString()
        });
    }

    return { character, isDuplicate: false };
}

// Middleware
function requireAuth(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/');
    }
}

function requireAdmin(req, res, next) {
    if (req.session.userId && req.session.isAdmin) {
        next();
    } else {
        res.status(403).send('Access denied');
    }
}

// Health check route
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: getKSTTimestamp(),
        uptime: Math.floor(process.uptime()),
        users: memoryDB.users.length,
        records: memoryDB.trainingRecords.length
    });
});

// Routes
app.get('/', async (req, res) => {
    if (req.session.userId) {
        if (req.session.isAdmin) {
            res.redirect('/admin');
        } else {
            res.redirect('/dashboard');
        }
    } else {
        try {
            const result = await query("SELECT value FROM settings WHERE key = $1", ['auto_signup']);
            const autoSignup = result.rows.length > 0 ? result.rows[0].value === '1' : false;
            res.render('login', { error: null, autoSignup });
        } catch (error) {
            console.error('설정 조회 오류:', error);
            res.render('login', { error: null, autoSignup: false });
        }
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // 자동 회원가입시 유효성 검사 (readin 제외)
        if (username !== 'readin') {
            const koreanOnly = /^[가-힣]{2,3}$/;
            if (!koreanOnly.test(username)) {
                const settingsResult = await query("SELECT value FROM settings WHERE key = $1", ['auto_signup']);
                const autoSignup = settingsResult.rows.length > 0 ? settingsResult.rows[0].value === '1' : false;
                res.render('login', { 
                    error: '이름은 2-3글자 한글만 가능합니다. (숫자, 영어, 특수문자 불가)', 
                    autoSignup 
                });
                return;
            }
        }
        
        const result = await query("SELECT * FROM users WHERE username = $1 AND status = 'active'", [username]);
        const user = result.rows[0];
        
        if (user) {
            const isValid = await bcrypt.compare(password, user.password);
            if (isValid) {
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.isAdmin = user.is_admin;
                req.session.level = user.level;
                
                await query("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);
                
                if (user.is_admin) {
                    res.redirect('/admin');
                } else {
                    res.redirect('/dashboard');
                }
            } else {
                const settingsResult = await query("SELECT value FROM settings WHERE key = $1", ['auto_signup']);
                const autoSignup = settingsResult.rows.length > 0 ? settingsResult.rows[0].value === '1' : false;
                res.render('login', { error: '비밀번호가 올바르지 않습니다.', autoSignup });
            }
        } else {
            const settingsResult = await query("SELECT value FROM settings WHERE key = $1", ['auto_signup']);
            const autoSignup = settingsResult.rows.length > 0 ? settingsResult.rows[0].value === '1' : false;
            
            if (autoSignup && password === '123456') {
                const hash = await bcrypt.hash(password, 10);
                const insertResult = await query(`
                    INSERT INTO users (username, password, level, status) 
                    VALUES ($1, $2, 3, 'active') RETURNING id
                `, [username, hash]);
                
                req.session.userId = insertResult.rows[0].id;
                req.session.username = username;
                req.session.isAdmin = false;
                req.session.level = 3;
                
                res.redirect('/dashboard');
            } else {
                res.render('login', { error: '사용자를 찾을 수 없습니다.', autoSignup });
            }
        }
    } catch (error) {
        console.error('로그인 오류:', error);
        res.render('login', { error: '서버 오류가 발생했습니다.', autoSignup: false });
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }

    const today = getTodayKST();
    const userId = req.session.userId;
    
    try {
        const attemptsResult = await query("SELECT * FROM daily_attempts WHERE user_id = $1 AND date = $2", [userId, today]);
        const attempts = attemptsResult.rows[0];
        const totalAttempts = attempts ? attempts.attempts : 0;
        const bonusAttempts = attempts ? attempts.bonus_attempts : 0;
        const remainingAttempts = Math.max(0, 1 + bonusAttempts - totalAttempts);
        
        const recordsResult = await query("SELECT * FROM training_records WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 50", [userId]);
        const records = recordsResult.rows;
        const difficultyRange = getDifficultyRange(req.session.level);
        
        res.render('dashboard', {
            username: req.session.username,
            remainingAttempts,
            records,
            difficultyRange
        });
    } catch (error) {
        console.error('대시보드 로딩 오류:', error);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// 심호흡 훈련 페이지
app.get('/breathing', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }

    res.render('breathing', {
        username: req.session.username
    });
});

app.get('/training', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }

    const today = getTodayKST();
    const userId = req.session.userId;
    
    try {
        const attemptsResult = await query("SELECT * FROM daily_attempts WHERE user_id = $1 AND date = $2", [userId, today]);
        const attempts = attemptsResult.rows[0];
        const totalAttempts = attempts ? attempts.attempts : 0;
        const bonusAttempts = attempts ? attempts.bonus_attempts : 0;
        const remainingAttempts = Math.max(0, 1 + bonusAttempts - totalAttempts);
        
        if (remainingAttempts <= 0) {
            res.redirect('/dashboard');
            return;
        }
        
        const difficultyRange = getDifficultyRange(req.session.level);
        const actualCount = Math.floor(Math.random() * (difficultyRange.max - difficultyRange.min + 1)) + difficultyRange.min;
        
        const visualFeedbackResult = await query("SELECT value FROM settings WHERE key = $1", ['show_visual_feedback']);
        const showVisualFeedback = visualFeedbackResult.rows.length > 0 ? visualFeedbackResult.rows[0].value === '1' : true;
        
        res.render('training', {
            username: req.session.username,
            actualCount,
            level: req.session.level,
            showVisualFeedback,
            difficultyRange
        });
    } catch (error) {
        console.error('훈련 페이지 로딩 오류:', error);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

app.post('/submit-answer', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.json({ success: false, message: '관리자는 훈련에 참여할 수 없습니다.' });
        return;
    }

    const { actualCount, userAnswer } = req.body;
    const today = getTodayKST();
    const userId = req.session.userId;
    const kstTimestamp = getKSTTimestamp();
    const difficultyRange = getDifficultyRange(req.session.level);
    
    try {
        const attemptsResult = await query("SELECT * FROM daily_attempts WHERE user_id = $1 AND date = $2", [userId, today]);
        const attempts = attemptsResult.rows[0];
        const totalAttempts = attempts ? attempts.attempts : 0;
        const bonusAttempts = attempts ? attempts.bonus_attempts : 0;
        const remainingAttempts = Math.max(0, 1 + bonusAttempts - totalAttempts);
        
        if (remainingAttempts <= 0) {
            res.json({ success: false, message: '오늘의 도전 기회를 모두 사용했습니다.' });
            return;
        }
        
        const isCorrect = isCorrectAnswer(parseInt(actualCount), parseInt(userAnswer));
        const answerResult = getAnswerScore(parseInt(actualCount), parseInt(userAnswer));
        
        await query(`
            INSERT INTO training_records (user_id, actual_count, user_answer, is_correct, level, date, timestamp, difficulty_range, bpm, score, answer_type) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [userId, actualCount, userAnswer, isCorrect, req.session.level, today, kstTimestamp, difficultyRange.range, 100, answerResult.score, answerResult.type]);
        
        if (attempts) {
            await query("UPDATE daily_attempts SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND date = $2", [userId, today]);
        } else {
            await query("INSERT INTO daily_attempts (user_id, date, attempts) VALUES ($1, $2, 1)", [userId, today]);
        }
        
        // 훈련 완료 +5 영혼석
        const newBalance = updateToken(userId, 5, 'training');

        res.json({
            success: true,
            isCorrect,
            actualCount,
            userAnswer,
            remainingAttempts: remainingAttempts - 1,
            soulStoneEarned: 5,
            soulStoneBalance: newBalance
        });
    } catch (error) {
        console.error('훈련 답변 제출 오류:', error);
        res.json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 1단계: 안구 회전 훈련
app.get('/step1-eye', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    res.render('step1-eye', {
        username: req.session.username
    });
});

// 2단계: 선생님 한마디
app.get('/step2-teacher', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    res.render('step2-teacher', {
        username: req.session.username
    });
});

// 3단계: 독서 노트
app.get('/step3-notebook', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    res.render('step3-notebook', {
        username: req.session.username
    });
});

// 4단계: 읽기듣기 트레이닝
app.get('/step4-listening', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    res.render('step4-listening', {
        username: req.session.username
    });
});

// 5단계: 책읽기 시작
app.get('/step5-reading', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    res.render('step5-reading', {
        username: req.session.username
    });
});

// 단계 완료 처리
app.post('/complete-step', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.json({ success: false, message: '관리자는 단계를 완료할 수 없습니다.' });
        return;
    }

    const { step } = req.body;
    const userId = req.session.userId;
    const today = getTodayKST();
    
    console.log('=== 단계 완료 요청 ===');
    console.log('userId:', userId, 'step:', step, 'today:', today);
    
    try {
        // 오늘 날짜의 완료 기록 찾기
        let completion = memoryDB.stepCompletions.find(sc => 
            sc.user_id === userId && sc.date === today
        );
        
        if (!completion) {
            // 새로운 기록 생성
            completion = {
                id: stepCompletionIdCounter++,
                user_id: userId,
                date: today,
                step1: step === 1,
                step2: step === 2,
                step3: step === 3,
                step4: step === 4,
                step5: step === 5,
                completed_at: new Date().toISOString()
            };
            memoryDB.stepCompletions.push(completion);
            console.log('✅ 새로운 완료 기록 생성:', completion);
        } else {
            // 기존 기록 업데이트
            completion[`step${step}`] = true;
            completion.completed_at = new Date().toISOString();
            console.log('✅ 기존 기록 업데이트:', completion);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ 단계 완료 처리 오류:', error);
        res.json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 오늘의 단계 완료 현황 조회 (관리자용)
app.get('/admin/today-steps', requireAdmin, async (req, res) => {
    const today = getTodayKST();
    
    try {
        const completions = memoryDB.stepCompletions.filter(sc => sc.date === today);
        const users = memoryDB.users.filter(u => !u.is_admin);
        
        const results = users.map(user => {
            const completion = completions.find(c => c.user_id === user.id);
            return {
                id: user.id,
                username: user.username,
                step1: completion?.step1 || false,
                step2: completion?.step2 || false,
                step3: completion?.step3 || false,
                step4: completion?.step4 || false,
                step5: completion?.step5 || false,
                completed_count: [
                    completion?.step1,
                    completion?.step2,
                    completion?.step3,
                    completion?.step4,
                    completion?.step5
                ].filter(Boolean).length
            };
        });
        
        res.json({ success: true, data: results });
    } catch (error) {
        console.error('단계 현황 조회 오류:', error);
        res.json({ success: false, data: [] });
    }
});

// 이번 달 랭킹 조회 (학생용)
app.get('/ranking', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    
    // 2026년 3월 1일 이전이면 접근 불가
    if (currentYear < 2026 || (currentYear === 2026 && currentMonth < 3)) {
        return res.render('ranking', {
            username: req.session.username,
            rankings: [],
            myRank: null,
            currentMonth: `${currentYear}년 ${currentMonth}월`,
            isActive: false,
            activationDate: '2026년 3월 1일'
        });
    }
    
    const rankings = calculateMonthlyRanking(currentYear, currentMonth);
    const myRank = rankings.findIndex(r => r.user_id === req.session.userId) + 1;
    const myData = rankings.find(r => r.user_id === req.session.userId);
    
    // 개인 목표 조회
    const goal = memoryDB.personalGoals.find(g => 
        g.user_id === req.session.userId && g.month === `${currentYear}-${String(currentMonth).padStart(2, '0')}`
    );
    
    const titles = checkTitles(req.session.userId);
    
    res.render('ranking', {
        username: req.session.username,
        rankings: rankings.slice(0, 5), // Top 5만
        myRank,
        myData,
        totalUsers: rankings.length,
        currentMonth: `${currentYear}년 ${currentMonth}월`,
        goal,
        titles,
        isActive: true
    });
});

// 개인 목표 설정
app.post('/set-goal', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.json({ success: false, message: '관리자는 목표를 설정할 수 없습니다.' });
        return;
    }
    
    const { targetRank } = req.body;
    const userId = req.session.userId;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    try {
        const existingGoal = memoryDB.personalGoals.find(g => 
            g.user_id === userId && g.month === currentMonth
        );
        
        if (existingGoal) {
            existingGoal.target_rank = parseInt(targetRank);
            existingGoal.updated_at = new Date().toISOString();
        } else {
            memoryDB.personalGoals.push({
                id: goalIdCounter++,
                user_id: userId,
                month: currentMonth,
                target_rank: parseInt(targetRank),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('목표 설정 오류:', error);
        res.json({ success: false, message: '목표 설정에 실패했습니다.' });
    }
});

// 전체 랭킹 조회 (관리자용)
app.get('/admin/full-ranking', requireAdmin, (req, res) => {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    
    const rankings = calculateMonthlyRanking(year, month);
    
    res.json({
        success: true,
        rankings,
        year,
        month
    });
});

// 배지 수여 (관리자용)
app.post('/admin/award-badges', requireAdmin, async (req, res) => {
    const { year, month } = req.body;
    const targetMonth = `${year}-${String(month).padStart(2, '0')}`;
    
    try {
        const rankings = calculateMonthlyRanking(year, month);
        
        // 기존 배지 삭제
        memoryDB.badges = memoryDB.badges.filter(b => b.month !== targetMonth);
        
        // 상위 5명에게 배지 수여
        const badgeTypes = [
            { rank: 1, type: 'gold', name: '골드 배지', reward: '5,000원' },
            { rank: 2, type: 'silver', name: '실버 배지', reward: '4,000원' },
            { rank: 3, type: 'bronze', name: '브론즈 배지', reward: '3,000원' },
            { rank: 4, type: 'excellence', name: '우수 배지', reward: '2,000원' },
            { rank: 5, type: 'excellence', name: '우수 배지', reward: '1,000원' }
        ];
        
       // 랭킹 토큰 보상 정의
        const rankingTokens = { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 };

        const rankingStones = { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 };

        badgeTypes.forEach((badge, index) => {
            if (rankings[index]) {
                memoryDB.badges.push({
                    id: badgeIdCounter++,
                    user_id: rankings[index].user_id,
                    username: rankings[index].username,
                    rank: badge.rank,
                    badge_type: badge.type,
                    badge_name: badge.name,
                    reward: badge.reward,
                    month: targetMonth,
                    awarded_at: new Date().toISOString()
                });

                // 랭킹 영혼석 지급
                const stones = rankingStones[badge.rank] || 0;
                if (stones > 0) updateToken(rankings[index].user_id, stones, 'ranking');
            }
        });
        
        res.json({ success: true, message: '배지가 수여되었습니다.' });
    } catch (error) {
        console.error('배지 수여 오류:', error);
        res.json({ success: false, message: '배지 수여에 실패했습니다.' });
    }
});

// 내 배지 조회
app.get('/my-badges', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin');
        return;
    }
    
    const myBadges = memoryDB.badges.filter(b => b.user_id === req.session.userId);
    
    res.render('my-badges', {
        username: req.session.username,
        badges: myBadges.sort((a, b) => b.awarded_at.localeCompare(a.awarded_at))
    });
});

app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const usersResult = await query("SELECT id, username, level, created_at, last_login, status FROM users WHERE is_admin = false ORDER BY username");
        const users = usersResult.rows;
        
        const settingsResult = await query("SELECT key, value, description FROM settings ORDER BY key");
        const settingsObj = {};
        settingsResult.rows.forEach(setting => {
            settingsObj[setting.key] = setting.value;
        });
        
        res.render('admin', {
            username: req.session.username,
            users,
            settings: settingsObj
        });
    } catch (error) {
        console.error('관리자 페이지 로딩 오류:', error);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

app.post('/admin/search', requireAdmin, async (req, res) => {
    const { searchTerm } = req.body;
    try {
        const result = await query("SELECT id, username, level, created_at, last_login, status FROM users WHERE is_admin = false AND username ILIKE $1 ORDER BY username", [`%${searchTerm}%`]);
        res.json({ users: result.rows });
    } catch (error) {
        console.error('사용자 검색 오류:', error);
        res.json({ users: [] });
    }
});

app.post('/admin/update-level', requireAdmin, async (req, res) => {
    const { userId, level } = req.body;
    try {
        await query("UPDATE users SET level = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [level, userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('레벨 업데이트 오류:', error);
        res.json({ success: false, message: '레벨 업데이트에 실패했습니다.' });
    }
});

app.post('/admin/bonus-attempt', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const today = getTodayKST();
    
    try {
        const attemptsResult = await query("SELECT * FROM daily_attempts WHERE user_id = $1 AND date = $2", [userId, today]);
        
        if (attemptsResult.rows.length > 0) {
            await query("UPDATE daily_attempts SET bonus_attempts = bonus_attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND date = $2", [userId, today]);
        } else {
            await query("INSERT INTO daily_attempts (user_id, date, bonus_attempts) VALUES ($1, $2, 1)", [userId, today]);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('보너스 기회 부여 오류:', error);
        res.json({ success: false, message: '보너스 기회 부여에 실패했습니다.' });
    }
});

app.post('/admin/toggle-setting', requireAdmin, async (req, res) => {
    const { key } = req.body;
    try {
        const result = await query("SELECT value FROM settings WHERE key = $1", [key]);
        const currentValue = result.rows[0]?.value || '0';
        const newValue = currentValue === '1' ? '0' : '1';
        
        await query("UPDATE settings SET value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE key = $3", [newValue, req.session.username, key]);
        res.json({ success: true, newValue });
    } catch (error) {
        console.error('설정 토글 오류:', error);
        res.json({ success: false });
    }
});

app.get('/admin/records/:date', requireAdmin, async (req, res) => {
    const date = req.params.date;
    const searchUser = req.query.user || '';
    
    try {
        const result = await query(`
            SELECT tr.*, u.username 
            FROM training_records tr 
            JOIN users u ON tr.user_id = u.id 
            WHERE tr.date = $1
        `, [date, searchUser]);
        
        res.json({ records: result.rows });
    } catch (error) {
        console.error('기록 조회 오류:', error);
        res.json({ records: [] });
    }
});

app.get('/admin/user-records/:userId', requireAdmin, async (req, res) => {
    const userId = req.params.userId;
    
    try {
        const result = await query(`
            SELECT tr.*, u.username 
            FROM training_records tr 
            JOIN users u ON tr.user_id = u.id 
            WHERE tr.user_id = $1
            ORDER BY tr.timestamp DESC
        `, [userId]);
        
        res.json({ 
            success: true, 
            records: result.rows,
            totalRecords: result.rows.length
        });
    } catch (error) {
        console.error('학생별 기록 조회 오류:', error);
        res.json({ success: false, records: [], totalRecords: 0 });
    }
});

app.get('/admin/user-stats/:userId', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        console.log('=== 통계 조회 시작 ===');
        console.log('사용자 ID:', userId);
        
        // 해당 사용자의 모든 기록
        const userRecords = memoryDB.trainingRecords.filter(r => r.user_id === userId);
        
        console.log('사용자 기록 수:', userRecords.length);
        
        // 총 시도 횟수
        const total = userRecords.length;
        
        // 정답 횟수
        const correct = userRecords.filter(r => r.is_correct).length;
        
        // 최근 7일 기록
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];
        const recent = userRecords.filter(r => r.date >= sevenDaysAgoStr).length;
        
        const stats = {
            totalAttempts: total,
            correctAnswers: correct,
            accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
            recentWeek: recent
        };
        
        console.log('통계 결과:', stats);
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('학생 통계 조회 오류:', error);
        console.error('에러 상세:', error.stack);
        res.json({ 
            success: false, 
            stats: null,
            error: error.message 
        });
    }
});

app.get('/admin/user-all-records/:userId', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        console.log('=== 전체 기록 조회 시작 ===');
        console.log('사용자 ID:', userId);
        console.log('전체 기록 수:', memoryDB.trainingRecords.length);
        
        // 해당 사용자의 모든 기록 가져오기
        const allRecords = memoryDB.trainingRecords.filter(r => r.user_id === userId);
        
        console.log('사용자 기록 수:', allRecords.length);
        
        if (allRecords.length === 0) {
            return res.json({ 
                success: true, 
                dailyRecords: [] 
            });
        }
        
        // 날짜별로 그룹화
        const dateGroups = {};
        
        allRecords.forEach(record => {
            const date = record.date;
            
            if (!dateGroups[date]) {
                dateGroups[date] = {
                    date: date,
                    level: record.level,
                    difficulty_range: record.difficulty_range || '-',
                    daily_attempts: 0,
                    correct_count: 0,
                    total_actual_count: 0,
                    records: []
                };
            }
            
            dateGroups[date].daily_attempts++;
            if (record.is_correct) {
                dateGroups[date].correct_count++;
            }
            dateGroups[date].total_actual_count += parseInt(record.actual_count);
            dateGroups[date].records.push({
                id: record.id,
                actual_count: record.actual_count,
                user_answer: record.user_answer,
                is_correct: record.is_correct,
                timestamp: record.timestamp
            });
        });
        
        // 배열로 변환하고 정렬
        const dailyRecords = Object.values(dateGroups).map(group => ({
            date: group.date,
            level: group.level,
            difficulty_range: group.difficulty_range,
            daily_attempts: group.daily_attempts,
            correct_count: group.correct_count,
            avg_actual_count: Math.round(group.total_actual_count / group.daily_attempts),
            records: group.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        })).sort((a, b) => b.date.localeCompare(a.date));
        
        console.log('날짜별 그룹 수:', dailyRecords.length);
        console.log('첫 번째 날짜:', dailyRecords[0]);
        
        res.json({ 
            success: true, 
            dailyRecords: dailyRecords
        });
    } catch (error) {
        console.error('전체 기록 조회 오류:', error);
        console.error('에러 상세:', error.stack);
        res.json({ 
            success: false, 
            dailyRecords: [],
            error: error.message 
        });
    }
});

app.get('/change-password', requireAuth, async (req, res) => {
    if (req.session.isAdmin) {
        res.render('change-password', { 
            username: req.session.username, 
            isAdmin: true,
            error: null 
        });
    } else {
        try {
            const result = await query("SELECT value FROM settings WHERE key = $1", ['allow_password_change']);
            const allowed = result.rows.length > 0 ? result.rows[0].value === '1' : true;
            if (allowed) {
                res.render('change-password', { 
                    username: req.session.username, 
                    isAdmin: false,
                    error: null 
                });
            } else {
                res.redirect('/dashboard');
            }
        } catch (error) {
            console.error('비밀번호 변경 페이지 로딩 오류:', error);
            res.redirect('/dashboard');
        }
    }
});

app.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    try {
        const result = await query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
        const user = result.rows[0];
        
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (isValid) {
            const hash = await bcrypt.hash(newPassword, 10);
            await query("UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [hash, req.session.userId]);
            res.redirect(req.session.isAdmin ? '/admin' : '/dashboard');
        } else {
            res.render('change-password', { 
                username: req.session.username, 
                isAdmin: req.session.isAdmin,
                error: '현재 비밀번호가 올바르지 않습니다.' 
            });
        }
    } catch (error) {
        console.error('비밀번호 변경 오류:', error);
        res.render('change-password', { 
            username: req.session.username, 
            isAdmin: req.session.isAdmin,
            error: '비밀번호 변경에 실패했습니다.' 
        });
    }
});

app.post('/admin/delete-user', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    
    try {
        const userResult = await query("SELECT username FROM users WHERE id = $1 AND is_admin = false", [userId]);
        if (userResult.rows.length === 0) {
            res.json({ success: false, message: '사용자를 찾을 수 없습니다.' });
            return;
        }
        
        await query("DELETE FROM training_records WHERE user_id = $1", [userId]);
        await query("DELETE FROM daily_attempts WHERE user_id = $1", [userId]);
        await query("DELETE FROM users WHERE id = $1 AND is_admin = false", [userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('사용자 삭제 오류:', error);
        res.json({ success: false, message: '사용자 삭제에 실패했습니다.' });
    }
});

app.post('/admin/force-change-password', requireAdmin, async (req, res) => {
    const { userId, newPassword } = req.body;
    
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        await query("UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND is_admin = false", [hash, userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('강제 비밀번호 변경 오류:', error);
        res.json({ success: false, message: '비밀번호 변경에 실패했습니다.' });
    }
});

// 영혼석 잔액 조회
app.get('/my-tokens', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        return res.json({ success: false, message: '관리자는 영혼석이 없습니다.' });
    }
    const balance = getTokenBalance(req.session.userId);
    const logs = memoryDB.tokenLogs
        .filter(l => l.user_id === req.session.userId)
        .reverse();
    res.json({ success: true, balance, logs });
});

// 영혼석 코드 입력 페이지
app.get('/enter-code-page', requireAuth, (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    const balance = getTokenBalance(req.session.userId);
    res.render('enter-code', {
        username: req.session.username,
        balance
    });
});
    if (req.session.isAdmin) {
        return res.json({ success: false, message: '관리자는 코드를 사용할 수 없습니다.' });
    }
    const { code } = req.body;
    const validCodes = { 'rd12972710': 1000 };

    if (!validCodes[code]) {
        return res.json({ success: false, message: '유효하지 않은 코드입니다.' });
    }

    const rewardAmount = validCodes[code];
    const newBalance = updateToken(req.session.userId, rewardAmount, 'code');

    res.json({
        success: true,
        message: `코드 입력 성공! 영혼석 ${rewardAmount}개가 지급되었습니다.`,
        soulStoneEarned: rewardAmount,
        soulStoneBalance: newBalance
    });
});

// 관리자 영혼석 지급
app.post('/admin/give-token', requireAdmin, (req, res) => {
    const { userId, amount } = req.body;
    const parsedAmount = parseInt(amount);

    if (!parsedAmount || parsedAmount <= 0) {
        return res.json({ success: false, message: '유효한 수량을 입력하세요.' });
    }

    const targetUser = memoryDB.users.find(u => u.id === parseInt(userId) && !u.is_admin);
    if (!targetUser) {
        return res.json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    const newBalance = updateToken(parseInt(userId), parsedAmount, 'admin');
    res.json({
        success: true,
        message: `${targetUser.username}에게 영혼석 ${parsedAmount}개를 지급했습니다.`,
        newBalance
    });
});

// 뽑기 페이지
app.get('/gacha', requireAuth, (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    const balance = getTokenBalance(req.session.userId);
    res.render('gacha', {
        username: req.session.username,
        balance,
        gachaCost: GACHA_COST
    });
});

// 뽑기 실행
app.post('/gacha/draw', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        return res.json({ success: false, message: '관리자는 뽑기를 할 수 없습니다.' });
    }

    const drawCount = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 10);
    const userId = req.session.userId;
    const totalCost = GACHA_COST * drawCount;
    const balance = getTokenBalance(userId);

    if (balance < totalCost) {
        return res.json({
            success: false,
            message: `영혼석이 부족합니다. (필요: ${totalCost}개, 보유: ${balance}개)`
        });
    }

    updateToken(userId, -totalCost, 'gacha');

    const results = [];
    for (let i = 0; i < drawCount; i++) {
        results.push(doGacha(userId));
    }

    res.json({
        success: true,
        results,
        totalCost,
        newBalance: getTokenBalance(userId)
    });
});

// 도감 페이지
app.get('/collection', requireAuth, (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    res.render('collection', { username: req.session.username });
});

// 도감 데이터
app.get('/collection/data', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        return res.json({ success: false });
    }
    const userId = req.session.userId;
    const myCollection = memoryDB.collections.filter(c => c.user_id === userId);

    const collectionData = CHARACTERS.map(char => {
        const owned = myCollection.find(c => c.character_id === char.id);
        return {
            id: char.id,
            grade: char.grade,
            name: owned ? char.name : '???',
            description: owned ? char.description : null,
            color: char.color,
            owned: !!owned,
            count: owned ? owned.count : 0,
            first_obtained_at: owned ? owned.first_obtained_at : null
        };
    });

    const stats = {
        SSS: { total: 1,  owned: 0 },
        SS:  { total: 3,  owned: 0 },
        S:   { total: 5,  owned: 0 },
        A:   { total: 7,  owned: 0 },
        B:   { total: 10, owned: 0 },
        C:   { total: 14, owned: 0 },
    };
    collectionData.forEach(c => { if (c.owned) stats[c.grade].owned++; });

    res.json({ success: true, collection: collectionData, stats });
});

// 관리자 특정 참가자 도감 조회
app.get('/admin/collection/:userId', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = memoryDB.users.find(u => u.id === userId && !u.is_admin);
    if (!user) return res.json({ success: false, message: '사용자를 찾을 수 없습니다.' });

    const myCollection = memoryDB.collections.filter(c => c.user_id === userId);
    const collectionData = CHARACTERS.map(char => {
        const owned = myCollection.find(c => c.character_id === char.id);
        return {
            ...char,
            owned: !!owned,
            count: owned ? owned.count : 0,
            first_obtained_at: owned ? owned.first_obtained_at : null
        };
    });

    res.json({ success: true, collection: collectionData, username: user.username });
});

// 관리자 캐릭터별 보유자 검색
app.get('/admin/collection/search/:characterId', requireAdmin, (req, res) => {
    const characterId = req.params.characterId;
    const character = CHARACTERS.find(c => c.id === characterId);
    if (!character) return res.json({ success: false, message: '캐릭터를 찾을 수 없습니다.' });

    const owners = memoryDB.collections
        .filter(c => c.character_id === characterId)
        .map(c => {
            const user = memoryDB.users.find(u => u.id === c.user_id);
            return {
                userId: c.user_id,
                username: user ? user.username : '???',
                count: c.count,
                first_obtained_at: c.first_obtained_at
            };
        })
        .sort((a, b) => a.username.localeCompare(b.username, 'ko'));

    res.json({ success: true, character, owners, ownerCount: owners.length });
});

// 이달의 뉴스 페이지
app.get('/news', requireAuth, (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    res.render('news', { username: req.session.username });
});

// 이달의 뉴스 데이터
app.get('/news/data', requireAuth, (req, res) => {
    const allNews = [...memoryDB.gachaNews]
        .reverse()
        .map(n => ({
            ...n,
            maskedName: maskName(n.username)
        }));
    res.json({ success: true, news: allNews });
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('세션 삭제 실패:', err);
        }
        res.redirect('/');
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('세션 삭제 실패:', err);
        }
        res.status(200).send('OK');
    });
});

// 종료 시 정리
process.on('SIGINT', () => {
    console.log('\n🛑 서버 종료 중...');
    console.log('✅ 메모리 데이터 정리됨');
    process.exit(0);
});

// 데이터베이스 초기화 및 서버 시작
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 === READIN 집중력 훈련 서버 시작 === 🚀`);
        console.log(`📡 서버 포트: ${PORT}`);
        console.log(`🕐 현재 KST 시간: ${getKSTTimestamp()}`);
        console.log(`📅 오늘 날짜 (KST): ${getTodayKST()}`);
        
        const days = getDaysSinceStart();
        const range = getDifficultyRange(3);
        console.log(`📊 8월 30일부터 경과일: ${days}일`);
        console.log(`🎯 현재 기본 레벨 난이도: ${range.range}`);
        console.log(`💾 메모리 데이터베이스 사용 (서버 재시작시 데이터 삭제)`);
        console.log(`👑 관리자 계정: readin / admin123`);
        console.log(`🎵 소리 재생 속도: 100 BPM`);
        console.log(`⏱️ 세션 만료: 로그인 후 30분`);
        console.log(`===============================================\n`);
        
        // Keep-Alive 시스템 (10분마다 자체 ping)
        setInterval(() => {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            
            fetch(`${url}/health`)
                .then(res => res.json())
                .then(data => {
                    console.log(`✅ Keep-Alive: ${data.timestamp} (Uptime: ${data.uptime}초, Users: ${data.users}, Records: ${data.records})`);
                })
                .catch(err => {
                    console.log(`⚠️ Keep-Alive 실패: ${err.message}`);
                });
        }, 10 * 60 * 1000); // 10분마다
        
        // 자동 배지 수여 스케줄러 (매일 23:59 체크)
        setInterval(() => {
            autoAwardBadges();
        }, 60 * 1000); // 1분마다 체크
        
        console.log('⏰ Keep-Alive 시스템 활성화 (10분 간격)');
        console.log('🔄 서버가 자동으로 깨어있는 상태를 유지합니다');
        console.log('💡 권장: UptimeRobot(https://uptimerobot.com)으로 외부 모니터링 추가');
        console.log('🏆 자동 배지 수여 시스템 활성화 (2026년 3월 31일부터 매달 말일 23:59)');
        console.log('📅 배지는 자동으로 상위 5명에게 수여됩니다\n');
    });
}).catch(error => {
    console.error('서버 시작 실패:', error);
    process.exit(1);
});
