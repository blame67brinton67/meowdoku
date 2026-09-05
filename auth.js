const crypto = require('crypto');
const { promisify } = require('util');
const { nanoid } = require('nanoid');

const scrypt = promisify(crypto.scrypt);
// Interactive-login cost: ~50 ms per hash, 16 MiB of memory.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16, KEY_BYTES = 64, TOKEN_BYTES = 32;
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY, SESSION_RENEW_BELOW = 25 * DAY;
// A rotated token keeps working for a moment so an in-flight request or a
// socket handshake that still carries it does not get bounced.
const ROTATED_GRACE = 60_000;
const GUEST_TTL = 7 * DAY;
const LOGIN_WINDOW = 10 * 60_000, LOGIN_MAX_FAILURES = 10;
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8, PASSWORD_MAX = 72;
const USERNAME_HINT = '帳號需為 3–20 個英數字、底線或連字號';
const PASSWORD_HINT = '密碼需為 8–72 個字元';
const WEAK_HINT = '這組密碼太常見了，貓咪一猜就中，換一組吧';
const LOGIN_FAILED = '帳號或密碼不正確';
const DISPLAY_NAME_MAX = 20;
// Control, format and zero-width characters are dropped so a name is always
// visible text; length is counted in code points so emoji are not split.
const NAME_JUNK = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
function sanitizeDisplayName(value) {
  return [...String(value ?? '').replace(NAME_JUNK, '').replace(/\s+/g, ' ').trim()].slice(0, DISPLAY_NAME_MAX).join('').trim();
}

// Lower-cased. Common leaks plus everything a cat-game player would try first.
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pass1234', 'passwort', 'passwords',
  '12345678', '123456789', '1234567890', '12345678910', '123123123', '123321123', '11111111', '00000000', '88888888', '66666666', '99999999', '12341234', '12344321',
  '87654321', '987654321', '0987654321', '1234567a', '1234567b', '12345678a', '123456789a', '123456789q', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', '1qaz2wsx3edc', 'qwertyuiop',
  'qwerty123', 'qwerty1234', 'qwertyui', 'qwerty12', 'asdfghjkl', 'asdfghjk', 'asdf1234', 'zxcvbnm123', 'zxcvbnm1', 'qazwsxedc', 'abcd1234', 'abcdefgh', 'abcdefg1',
  'abc12345', 'abc123456', 'a1b2c3d4', 'iloveyou', 'iloveyou1', 'iloveyou2', 'ilovey0u', 'loveyou1', 'lovelove', 'sunshine', 'sunshine1', 'princess', 'princess1',
  'football', 'football1', 'baseball', 'baseball1', 'basketball', 'soccer123', 'superman', 'superman1', 'batman123', 'starwars', 'star wars', 'pokemon1', 'pokemon123',
  'welcome1', 'welcome123', 'whatever', 'whatever1', 'trustno1', 'letmein1', 'letmein123', 'michael1', 'jennifer', 'jordan23', 'charlie1', 'charlie123', 'nicholas',
  'jonathan', 'anthony1', 'matthew1', 'daniel12', 'thomas12', 'robert12', 'william1', 'jessica1', 'ashley12', 'amanda12', 'samantha', 'michelle', 'michelle1',
  'computer', 'computer1', 'internet', 'internet1', 'shadow12', 'shadow123', 'master12', 'master123', 'monkey12', 'monkey123', 'dragon12', 'dragon123', 'killer12',
  'hunter12', 'hunter123', 'chocolate', 'cheese123', 'summer12', 'summer123', 'winter12', 'winter123', 'freedom1', 'freedom123', 'cookie12', 'cookie123', 'butterfly',
  'liverpool', 'chelsea1', 'arsenal1', 'barcelona', 'manchester', 'ferrari1', 'mercedes', 'corvette', 'mustang1', 'yamaha12', 'harley12', 'ginger12', 'pepper12',
  'buster12', 'tigger12', 'snoopy12', 'peanut12', 'maggie12', 'bailey12', 'shadow1234', 'hello123', 'hello1234', 'helloworld', 'hello world', 'goodbye1', 'test1234',
  'testtest', 'test12345', 'testing1', 'testing123', 'admin123', 'admin1234', 'admin12345', 'administrator', 'root1234', 'rootroot', 'system123', 'changeme',
  'changeme1', 'default1', 'guest123', 'guest1234', 'user1234', 'username', 'login123', 'secret12', 'secret123', 'private1', 'access12', 'access123', 'letmein!',
  'qwerty!@#', 'q1w2e3r4', 'q1w2e3r4t5', 'zaq12wsx', 'zaq1zaq1', 'xsw2zaq1', '1qazxsw2', '!qaz2wsx', 'asdfasdf', 'asdasdasd', 'qweqweqwe', 'zxczxczxc', 'qwerqwer',
  'aaaaaaaa', 'bbbbbbbb', 'zzzzzzzz', '11223344', '12121212', '12312312', '13131313', '19921992', '19941994', '19951995', '19961996', '19971997', '19981998',
  '19991999', '20002000', '20012001', '20022002', '20032003', '20042004', '20052005', '20062006', '20072007', '20082008', '20092009', '20102010', '20112011',
  '20122012', '20132013', '20142014', '20152015', '20162016', '20172017', '20182018', '20192019', '20202020', '20212021', '20222022', '20232023', '20242024',
  '20252025', '20262026', '12301230', '12345679', '123456780', '1234512345', '112233445', '147258369', '159357159', '741852963', '963852741', '369258147',
  '789456123', '123789456', '456123789', '1029384756', '0123456789', '01234567', '76543210', '55555555', '77777777', '22222222', '33333333', '44444444',
  'meowdoku', 'meowdoku1', 'meowdoku123', 'meowdoku2024', 'meowdoku2025', 'meowdoku2026', 'meowmeow', 'meowmeow1', 'meowmeow123', 'catcatcat', 'kittycat', 'kittycat1',
  'catlover', 'catlover1', 'catlover123', 'ilovecats', 'ilovecat', 'nekoneko', 'nekoneko1', 'nyannyan', 'nyancat1', 'sudoku12', 'sudoku123', 'puzzle12', 'puzzle123',
  'gamer123', 'gaming123', 'player12', 'player123', 'player1234', 'winner12', 'winner123', 'champion', 'champion1', 'victory1', 'legend12', 'legend123',
  'taiwan123', 'taiwan2024', 'taipei123', 'formosa1', 'chinese1', 'japan123', 'tokyo123', 'korea123', 'america1', 'canada123', 'london12', 'london123',
  'google123', 'facebook', 'facebook1', 'youtube1', 'youtube123', 'twitter1', 'instagram', 'linkedin', 'microsoft', 'windows1', 'windows10', 'windows7',
  'samsung1', 'samsung123', 'iphone12', 'iphone123', 'android1', 'android123', 'nintendo', 'nintendo1', 'playstation', 'minecraft', 'minecraft1', 'fortnite',
  'fortnite1', 'roblox123', 'genshin1', 'genshin123', 'valorant', 'valorant1', 'overwatch', 'pikachu1', 'pikachu123', 'charizard', 'naruto12', 'naruto123',
  'onepiece', 'onepiece1', 'dragonball', 'sasuke12', 'goku1234', 'luffy123', 'zelda123', 'mario123', 'kirby123', 'sonic123', 'zelda1234', 'link1234',
  'spiderman', 'spiderman1', 'ironman1', 'ironman123', 'avengers', 'avengers1', 'thanos123', 'hulk1234', 'wolverine', 'deadpool', 'deadpool1', 'joker123',
  'harrypotter', 'hermione', 'gryffindor', 'slytherin', 'hogwarts', 'hogwarts1', 'voldemort', 'dumbledore', 'gandalf1', 'frodo123', 'legolas1', 'aragorn1',
  'skywalker', 'darthvader', 'yoda1234', 'chewbacca', 'r2d2c3po', 'startrek', 'startrek1', 'godzilla', 'godzilla1', 'jurassic', 'titanic1', 'frozen123',
  'elsa1234', 'simba123', 'mickey12', 'mickey123', 'minnie12', 'donald12', 'goofy123', 'pluto123', 'disney12', 'disney123', 'pixar123', 'marvel12', 'marvel123',
  'metallica', 'nirvana1', 'beatles1', 'eminem12', 'eminem123', 'rihanna1', 'beyonce1', 'taylor12', 'taylor123', 'swiftie1', 'blackpink', 'blackpink1',
  'bts12345', 'btsarmy1', 'jungkook', 'twice123', 'exo12345', 'kpop1234', 'jpop1234', 'anime123', 'manga123', 'otaku123', 'waifu123', 'senpai12', 'senpai123',
  'kawaii12', 'kawaii123', 'sakura12', 'sakura123', 'hinata12', 'kakashi1', 'itachi12', 'madara12', 'tanjiro1', 'nezuko12', 'eren1234', 'mikasa12', 'levi1234',
  'chicken1', 'chicken123', 'banana12', 'banana123', 'orange12', 'orange123', 'apple123', 'apple1234', 'cherry12', 'cherry123', 'purple12', 'purple123',
  'yellow12', 'yellow123', 'silver12', 'silver123', 'golden12', 'golden123', 'diamond1', 'diamond123', 'rainbow1', 'rainbow123', 'flower12', 'flower123',
  'coffee12', 'coffee123', 'pizza123', 'pizza1234', 'burger12', 'nutella1', 'chocolate1', 'icecream', 'icecream1', 'bubbletea', 'boba1234', 'milktea1', 'milktea123',
  'happy123', 'happy1234', 'smile123', 'lucky123', 'lucky1234', 'angel123', 'angel1234', 'heaven12', 'heaven123', 'forever1', 'forever123', 'friends1', 'friends123',
  'family12', 'family123', 'mother12', 'father12', 'brother1', 'sister12', 'sister123', 'baby1234', 'babygirl', 'babyboy1', 'sweetie1', 'honey123', 'darling1',
  'beautiful', 'gorgeous', 'handsome', 'awesome1', 'awesome123', 'amazing1', 'perfect1', 'perfect123', 'special1', 'nothing1', 'nothing123', 'anything', 'something',
  'mypassword', 'mypass123', 'passpass', 'pass12345', 'password!', 'password@', 'password#', 'password.', 'password01', 'password00', 'password99', 'password2024',
  'password2025', 'password2026', 'p4ssw0rd', 'pa55word', 'pa55w0rd', 'passw0rd1', 'drowssap', 'secret1234', 'letmein12', 'openseame', 'opensesame', 'abracadabra',
  'trustno1!', 'loveme123', 'kissme123', 'fuckyou1', 'fuckyou123', 'fuckoff1', 'asshole1', 'bitch123', 'blink182', 'greenday', 'linkinpark', 'slipknot', 'rammstein',
  'starcraft', 'warcraft1', 'warcraft3', 'diablo123', 'counterstrike', 'halflife', 'halflife2', 'portal12', 'skyrim12', 'skyrim123', 'fallout1', 'fallout4',
  'gta12345', 'gtav1234', 'fifa1234', 'fifa2024', 'nba2k123', 'madden12', 'callofduty', 'battlefield', 'apexlegends', 'leagueoflegends', 'lol12345', 'dota2dota2',
  'tekken12', 'streetfighter', 'mortalkombat', 'smashbros', 'animalcrossing', 'splatoon', 'metroid1', 'castlevania', 'megaman1', 'pacman12', 'pacman123',
  'tetris12', 'tetris123', 'bomberman', 'contra12', 'doom1234', 'quake123', 'wolfenstein', 'darksouls', 'eldenring', 'bloodborne', 'sekiro12', 'hollowknight',
  'celeste1', 'undertale', 'deltarune', 'stardew1', 'terraria', 'terraria1', 'factorio', 'rimworld', 'kerbal12', 'civilization', 'civ12345', 'ageofempires',
  'starwars1', 'starwars123', 'startrek123', 'matrix12', 'matrix123', 'neo12345', 'trinity1', 'morpheus', 'inception', 'interstellar', 'avatar12', 'avatar123',
  'jamesbond', 'bond0007', '007bond1', 'sherlock', 'sherlock1', 'watson12', 'moriarty', 'hannibal', 'lecter12', 'gotham12', 'gotham123', 'arkham12', 'wayne123',
  'brucewayne', 'clarkkent', 'peterparker', 'tonystark', 'stevecerogers', 'natasha1', 'blackwidow', 'scarlett', 'hawkeye1', 'nickfury', 'loki1234', 'thor1234',
  'odin1234', 'asgard12', 'wakanda1', 'vibranium', 'infinity', 'infinity1', 'endgame1', 'endgame123', 'multiverse', 'quantum1', 'quantum123', 'physics1',
  'chemistry', 'biology1', 'biology123', 'science1', 'science123', 'history1', 'history123', 'english1', 'english123', 'spanish1', 'french12', 'french123',
  'german12', 'german123', 'italian1', 'russian1', 'student1', 'student123', 'teacher1', 'teacher123', 'school12', 'school123', 'college1', 'college123',
  'university', 'campus12', 'library1', 'library123', 'doctor12', 'doctor123', 'nurse123', 'lawyer12', 'engineer', 'engineer1', 'developer', 'programmer',
  'hacker12', 'hacker123', 'hackerman', 'anonymous', 'anonymous1', 'nobody12', 'nobody123', 'somebody', 'everyone', 'everybody', 'yourmom1', 'yourmom123',
  'sexygirl', 'sexyboy1', 'hotgirl1', 'hotboy12', 'cutegirl', 'cuteboy1', 'pretty12', 'pretty123', 'lovely12', 'lovely123', 'cutie123', 'sweet123', 'sweet1234',
  'january1', 'february', 'march123', 'april123', 'april1234', 'mayday12', 'june1234', 'july1234', 'august12', 'august123', 'september', 'october1', 'october123',
  'november', 'december', 'monday12', 'monday123', 'tuesday1', 'wednesday', 'thursday', 'friday12', 'friday123', 'saturday', 'sunday12', 'sunday123', 'weekend1',
  'birthday', 'birthday1', 'christmas', 'christmas1', 'halloween', 'newyear1', 'newyear2024', 'newyear2025', 'valentine', 'easter12', 'holiday1', 'holiday123',
  'vacation', 'vacation1', 'beach123', 'ocean123', 'ocean1234', 'river123', 'mountain', 'mountain1', 'forest12', 'forest123', 'desert12', 'island12', 'island123',
  'thunder1', 'thunder123', 'lightning', 'tornado1', 'hurricane', 'blizzard', 'blizzard1', 'snowflake', 'snowman1', 'iceberg1', 'volcano1', 'earthquake',
  'universe', 'universe1', 'galaxy12', 'galaxy123', 'planet12', 'planet123', 'jupiter1', 'saturn12', 'saturn123', 'mercury1', 'neptune1', 'pluto1234', 'earth123',
  'moonlight', 'starlight', 'sunlight', 'daylight', 'midnight', 'midnight1', 'twilight', 'twilight1', 'eclipse1', 'horizon1', 'horizon123', 'skyline1',
  'freedom!1', 'liberty1', 'liberty123', 'justice1', 'justice123', 'america123', 'usa12345', 'canada12', 'mexico12', 'brazil12', 'brazil123', 'england1',
  'ireland1', 'scotland', 'germany1', 'germany123', 'france12', 'france123', 'italy123', 'italy1234', 'spain123', 'spain1234', 'portugal', 'holland1',
  'sweden12', 'sweden123', 'norway12', 'norway123', 'denmark1', 'finland1', 'poland12', 'poland123', 'russia12', 'russia123', 'ukraine1', 'turkey12',
  'greece12', 'greece123', 'egypt123', 'israel12', 'india123', 'india1234', 'pakistan', 'china123', 'china1234', 'japan1234', 'korea1234', 'vietnam1',
  'thailand', 'thailand1', 'malaysia', 'singapore', 'indonesia', 'philippines', 'australia', 'sydney12', 'sydney123', 'melbourne', 'newzealand', 'kiwi1234',
  'hongkong', 'hongkong1', 'shanghai', 'beijing1', 'beijing123', 'kaohsiung', 'taichung', 'tainan12', 'tainan123', 'hsinchu1', 'keelung1', 'hualien1',
  'ntu12345', 'nctu1234', 'nthu1234', 'ncku1234', 'ncu12345', 'nsysu123', 'ntust123', 'ntnu1234', 'nccu1234', 'ncnu1234', 'fju12345', 'tku12345',
  'ilovetaiwan', 'taiwanno1', 'taiwan888', 'taiwan168', 'a1234567', 'a12345678', 'a123456789', 'aa123456', 'ab123456', 'abc12345678', 'asd12345', 'asd123456',
  'qwe12345', 'qwe123456', 'zxc12345', 'zxc123456', 'qaz12345', 'wsx12345', 'edc12345', 'q1234567', 'q12345678', 'w1234567', 'z1234567', 'x1234567',
  'aaa12345', 'aaaa1111', 'abcabc12', 'abcabcabc', 'abc123abc', 'abc123abc123', '123abc123', '123qweasd', '123qwe123', '123asd123', '123zxc123', '123456qwe',
  '123456asd', '123456zxc', '123456abc', '123456aa', '123456a1', '1234567q', '1234567890a', '1234567890q', '0000000000', '1111111111', '1234123412',
  '2580258025', '25802580', '14725836', '15935700', '75395100', '85208520', '95175300', '15975300', '35715900', '45678912', '56789012', '67890123',
  '78901234', '89012345', '90123456', '01010101', '10101010', '12121212', '21212121', '69696969', '80808080', '90909090', '31415926', '27182818', '16180339',
  '14142135', '11235813', '112358132134', '01234567890', 'abcdef12', 'abcdef123', 'abcdefg123', 'abcdefgh1', 'abcdefghij', 'abcdefghijk', 'abcdefghijkl',
  'zyxwvuts', 'zyxwvutsr', 'qwertyuiopasdfghjkl', 'qwertyuiopasdf', 'asdfghjklqwertyuiop', 'asdfghjkl;', "asdfghjkl;'", 'zxcvbnm,.', 'zxcvbnm,./', 'poiuytrewq',
  'lkjhgfdsa', 'mnbvcxz1', 'mnbvcxz123', 'yuiopasd', 'ghjklzxc', 'wertyuio', 'sdfghjkl', 'xcvbnm12', 'xcvbnm123', 'dfghjkl1', 'fghjkl12', 'ertyuiop',
  'rtyuiop1', 'tyuiop12', 'uiop1234', 'iop12345', 'op123456', 'qwertyqwerty', 'qwerty1q2w3e', 'qwerty12345', 'qwerty123456', 'qwerty1234567', 'qwerty!@#$',
  'qwerty!!', 'qwerty..', 'qwerty--', 'qwerty__', 'qwerty++', 'qwerty==', 'qwerty00', 'qwerty11', 'qwerty22', 'qwerty33', 'qwerty44', 'qwerty55', 'qwerty66',
  'qwerty77', 'qwerty88', 'qwerty99', 'qwertyab', 'qwertyabc', 'qwertyzxc', 'qwertyasd', 'asdqwerty', 'zxcqwerty', 'qwertyuiop1', 'qwertyuiop12', 'qwertyuiop123',
  'azertyuiop', 'azerty12', 'azerty123', 'azerty1234', 'qwertz12', 'qwertz123', 'qwertz1234', 'qwertzuiop', 'yxcvbnm1', 'yxcvbnm12', 'yxcvbnm123',
  'a1s2d3f4', 'a1s2d3f4g5', 'z1x2c3v4', 'z1x2c3v4b5', 'q1w2e3r4t5y6', '1q2w3e4r5t6y', '1a2b3c4d', '1a2b3c4d5e', '1z2x3c4v', '1z2x3c4v5b', '!@#$%^&*',
  '!@#$%^&*(', '!@#$%^&*()', '!@#$1234', '1234!@#$', 'abcd!@#$', '!qaz@wsx', '!qaz2wsx#edc', '1qaz@wsx', '1qaz!qaz', 'zaq1!qaz', 'zaq1xsw2', 'zaq1xsw2cde3',
  'xsw2cde3', 'cde3vfr4', 'vfr4bgt5', 'bgt5nhy6', 'nhy6mju7', 'mju7,ki8', '1qazse4r', '2wsxcde3', '1qazxsw23edc', 'qazxswedc', 'qazwsx12', 'qazwsx123',
  'qazwsxedcrfv', 'wsxedcrfv', 'edcrfvtgb', 'rfvtgbyhn', 'tgbyhnujm', 'plokijuh', 'plmoknijb', 'okmijnuhb', 'ijnuhbygv', 'uhbygvtfc', 'ygvtfcrdx',
  'tfcrdxesz', 'rdxeszwaq', 'eszwaq12', 'mnbvcxzlkjhgfdsa', 'poiuytrewqlkjhgfdsa', 'qpwoeiruty', 'qpwoeiru', 'alskdjfh', 'alskdjfhg', 'zmxncbv1', 'zmxncbv12',
  'qpalzm12', 'qpalzm123', 'qpalzmwoskxn', 'woskxn12', 'eidkcm12', 'plokmijn', 'ploki123', 'ploki1234', 'okmnji12', 'ijnhbg12', 'uhbvgy12', 'ygvcft12',
  'tfcxdr12', 'rdxzse12', 'eszaw123', 'wazse123', 'qaswed12', 'qaswedrf', 'qaswedrft', 'asdfqwer', 'qwerasdf', 'zxcvasdf', 'asdfzxcv', 'qwerzxcv', 'zxcvqwer',
  'qweasdzxc', 'zxcasdqwe', 'qazwsxedc123', 'qweasdzxc123', 'asdzxcqwe', 'qwe123asd', 'asd123qwe', 'zxc123qwe', 'qwe123zxc', 'asd123zxc', 'zxc123asd',
  'iloveyou!', 'iloveyou.', 'iloveyou12', 'iloveyou123', 'iloveyou1234', 'iloveyou2', 'iloveu123', 'iloveu1234', 'loveyou123', 'loveme1234', 'lovelove1',
  'lovelove123', 'love1234', 'love12345', 'love123456', 'ilovemom', 'ilovedad', 'ilovegod', 'ilovejesus', 'jesus123', 'jesus1234', 'jesuschrist', 'godisgood',
  'godislove', 'blessed1', 'blessed123', 'faith123', 'faith1234', 'grace123', 'grace1234', 'hope1234', 'hope12345', 'peace123', 'peace1234', 'buddha12',
  'buddha123', 'karma123', 'karma1234', 'zen12345', 'lotus123', 'lotus1234', 'temple12', 'temple123', 'shrine12', 'shrine123', 'church12', 'church123',
  'mosque12', 'allahuakbar', 'bismillah', 'inshallah', 'mashallah', 'alhamdulillah', 'shalom12', 'shalom123', 'namaste1', 'namaste123', 'om123456',
  'mantra12', 'mantra123', 'yoga1234', 'yoga12345', 'pilates1', 'fitness1', 'fitness123', 'workout1', 'workout123', 'gymrat12', 'gymrat123', 'muscle12',
  'muscle123', 'protein1', 'protein123', 'healthy1', 'healthy123', 'running1', 'running123', 'cycling1', 'cycling123', 'swimming', 'swimming1', 'tennis12',
  'tennis123', 'golf1234', 'golf12345', 'hockey12', 'hockey123', 'rugby123', 'rugby1234', 'cricket1', 'cricket123', 'boxing12', 'boxing123', 'karate12',
  'karate123', 'judo1234', 'kungfu12', 'kungfu123', 'taekwondo', 'wrestling', 'skating1', 'skating123', 'skiing12', 'skiing123', 'surfing1', 'surfing123',
  'climbing', 'climbing1', 'hiking12', 'hiking123', 'camping1', 'camping123', 'fishing1', 'fishing123', 'hunting1', 'hunting123', 'archery1', 'archery123',
  'shooting', 'shooting1', 'bowling1', 'bowling123', 'billiard', 'snooker1', 'darts123', 'darts1234', 'chess123', 'chess1234', 'checkers', 'poker123',
  'poker1234', 'blackjack', 'roulette', 'casino12', 'casino123', 'jackpot1', 'jackpot123', 'lottery1', 'lottery123', 'bingo123', 'bingo1234', 'mahjong1',
  'mahjong123', 'gomoku12', 'gomoku123', 'xiangqi1', 'xiangqi123', 'shogi123', 'shogi1234', 'go123456', 'weiqi123', 'baduk123', 'othello1', 'othello123',
  'reversi1', 'reversi123', 'connect4', 'battleship', 'monopoly', 'monopoly1', 'scrabble', 'scrabble1', 'clue1234', 'risk1234', 'catan123', 'catan1234',
  'uno12345', 'uno123456', 'jenga123', 'jenga1234', 'twister1', 'twister123', 'dominoes', 'dominoes1', 'yahtzee1', 'yahtzee123', 'cribbage', 'euchre12',
  'canasta1', 'pinochle', 'solitaire', 'freecell', 'spider12', 'spider123', 'hearts12', 'hearts123', 'spades12', 'spades123', 'bridge12', 'bridge123',
  'rummy123', 'rummy1234', 'gin12345', 'crazy8s1', 'gofish12', 'gofish123', 'oldmaid1', 'warcard1', 'slapjack', 'speed123', 'speed1234', 'spit1234'
]);

const isRepeated = value => /^(.)\1+$/.test(value);
const isSequential = value => {
  const codes = [...value].map(char => char.charCodeAt(0));
  const step = codes[1] - codes[0];
  return (step === 1 || step === -1) && codes.every((code, index) => index === 0 || code - codes[index - 1] === step);
};

function validateUsername(username) {
  return typeof username === 'string' && USERNAME.test(username) ? null : USERNAME_HINT;
}
function validatePassword(password, username = '') {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return PASSWORD_HINT;
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower) || isRepeated(lower) || isSequential(lower)) return WEAK_HINT;
  if (username && lower.includes(String(username).toLowerCase())) return WEAK_HINT;
  return null;
}

async function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
  const hash = await scrypt(Buffer.from(password, 'utf8'), salt, KEY_BYTES, SCRYPT);
  return { hash, salt };
}
async function verifyPassword(password, hash, salt) {
  const candidate = await scrypt(Buffer.from(String(password), 'utf8'), salt, KEY_BYTES, SCRYPT);
  return hash.length === candidate.length && crypto.timingSafeEqual(hash, candidate);
}

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name || row.username, isAdmin: Boolean(row.is_admin), avatar: row.avatar, frame: row.frame };
}

function createAuth(db, { now = Date.now } = {}) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, username, password_hash, salt, created_at, display_name) VALUES (?, ?, ?, ?, ?, ?)'),
    setAdmin: db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?'),
    insertGuest: db.prepare('INSERT INTO guests (id, created_at, last_seen) VALUES (?, ?, ?)'),
    touchGuest: db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, guest_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    expireSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteGuestSessions: db.prepare('DELETE FROM sessions WHERE guest_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    purgeGuests: db.prepare('DELETE FROM guests WHERE last_seen <= ? AND id NOT IN (SELECT guest_id FROM sessions WHERE guest_id IS NOT NULL)'),
    failures: db.prepare('SELECT COUNT(*) AS count, MIN(at) AS oldest FROM login_attempts WHERE ip = ? AND at > ?'),
    insertFailure: db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)'),
    clearFailures: db.prepare('DELETE FROM login_attempts WHERE ip = ?'),
    pruneFailures: db.prepare('DELETE FROM login_attempts WHERE at <= ?'),
    claimed: db.prepare('SELECT user_id FROM claimed_visitors WHERE visitor_id = ?'),
    insertClaim: db.prepare('INSERT INTO claimed_visitors (visitor_id, user_id, claimed_at) VALUES (?, ?, ?)'),
    upsertProgress: db.prepare('INSERT OR IGNORE INTO progress (user_id, level_id, cleared_at, ms, hints_used, mistakes) VALUES (?, ?, ?, ?, ?, ?)'),
    cleared: db.prepare('SELECT level_id FROM progress WHERE user_id = ? ORDER BY cleared_at'),
    upsertHistory: db.prepare('INSERT OR IGNORE INTO match_history (user_id, match_id, finished_at, record_json) VALUES (?, ?, ?, ?)'),
    history: db.prepare('SELECT record_json FROM match_history WHERE user_id = ? ORDER BY finished_at DESC LIMIT ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    setFrame: db.prepare('UPDATE users SET frame = ? WHERE id = ?'),
    leaderboard: db.prepare('SELECT u.username, u.display_name, u.avatar, u.frame, COUNT(p.level_id) AS cleared FROM users u JOIN progress p ON p.user_id = u.id GROUP BY u.id')
  };

  function issueSession({ userId = null, guestId = null, userAgent }) {
    const token = newToken(), at = now();
    q.insertSession.run(hashToken(token), userId, guestId, at, at + (userId ? SESSION_TTL : GUEST_TTL), String(userAgent || '').slice(0, 200));
    return token;
  }

  async function register({ username, password, userAgent }) {
    const usernameError = validateUsername(username); if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password, username); if (passwordError) return { error: passwordError };
    if (q.userByName.get(username)) return { error: '這個帳號已經有人用了' };
    const { hash, salt } = await hashPassword(password);
    const id = `u_${nanoid(12)}`;
    try { q.insertUser.run(id, username, hash, salt, now(), username); }
    catch (error) { if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return { error: '這個帳號已經有人用了' }; throw error; }
    return { user: publicUser(q.userById.get(id)), token: issueSession({ userId: id, userAgent }) };
  }

  function loginCooldown(ip) {
    const at = now();
    q.pruneFailures.run(at - LOGIN_WINDOW);
    const { count, oldest } = q.failures.get(ip, at - LOGIN_WINDOW);
    return count >= LOGIN_MAX_FAILURES ? Math.max(1, Math.ceil((oldest + LOGIN_WINDOW - at) / 1000)) : 0;
  }

  // Unknown account and wrong password take the same path and the same
  // message; the dummy hash keeps the timing of the two alike.
  async function login({ username, password, ip, userAgent }) {
    const retryAfter = loginCooldown(ip);
    if (retryAfter) return { error: `登入失敗次數太多，請 ${retryAfter} 秒後再試`, retryAfter };
    const row = typeof username === 'string' ? q.userByName.get(username) : null;
    const ok = row
      ? await verifyPassword(String(password ?? ''), row.password_hash, row.salt)
      : await verifyPassword(String(password ?? ''), DUMMY.hash, DUMMY.salt) && false;
    if (!ok) { q.insertFailure.run(ip, now()); return { error: LOGIN_FAILED }; }
    q.clearFailures.run(ip);
    return { user: publicUser(row), token: issueSession({ userId: row.id, userAgent }) };
  }

  function logout(token) {
    if (typeof token === 'string' && token) q.deleteSession.run(hashToken(token));
  }

  function createGuest(userAgent) {
    const id = `g_${nanoid(12)}`, at = now();
    q.insertGuest.run(id, at, at);
    return { identity: { kind: 'guest', id }, token: issueSession({ guestId: id, userAgent }) };
  }

  // Resolves a cookie token to an identity. A user session past the renewal
  // point is rotated: the caller must set `renewedToken` as the new cookie.
  // Callers that cannot set a cookie (socket handshakes) pass renew: false.
  function resolve(token, userAgent, { renew = true } = {}) {
    if (typeof token !== 'string' || !token || token.length > 128) return null;
    const at = now();
    const session = q.session.get(hashToken(token));
    if (!session || session.expires_at <= at) return null;
    if (session.guest_id) {
      q.touchGuest.run(at, session.guest_id);
      q.expireSession.run(at + GUEST_TTL, session.token_hash);
      return { identity: { kind: 'guest', id: session.guest_id } };
    }
    const row = q.userById.get(session.user_id);
    if (!row) return null;
    const identity = { kind: 'user', ...publicUser(row) };
    if (!renew || session.expires_at - at >= SESSION_RENEW_BELOW) return { identity };
    const renewedToken = issueSession({ userId: row.id, userAgent });
    q.expireSession.run(at + ROTATED_GRACE, session.token_hash);
    return { identity, renewedToken };
  }

  function purgeExpired() {
    const at = now();
    q.purge.run(at); q.purgeGuests.run(at - GUEST_TTL); q.pruneFailures.run(at - LOGIN_WINDOW);
  }

  function bootstrapAdmin(username) {
    if (!username) return false;
    return q.setAdmin.run(username).changes > 0;
  }

  const claimVisitor = db.transaction((userId, visitorId, { cleared = [], history = [] }) => {
    if (q.claimed.get(visitorId)) return false;
    q.insertClaim.run(visitorId, userId, now());
    for (const levelId of cleared) q.upsertProgress.run(userId, String(levelId), now(), null, 0, 0);
    for (const record of history) q.upsertHistory.run(userId, String(record.matchId), Number(record.finishedAt) || now(), JSON.stringify(record));
    return true;
  });

  return {
    register, login, logout, resolve, createGuest, purgeExpired, bootstrapAdmin, loginCooldown, claimVisitor,
    clearLevel: (userId, levelId, { ms = null, hints = 0, mistakes = 0 } = {}) => q.upsertProgress.run(userId, levelId, now(), ms, hints, mistakes),
    clearedLevels: userId => q.cleared.all(userId).map(row => row.level_id),
    recordMatch: (userId, record) => q.upsertHistory.run(userId, record.matchId, record.finishedAt, JSON.stringify(record)),
    matchHistory: (userId, limit = 50) => q.history.all(userId, limit).map(row => JSON.parse(row.record_json)),
    setDisplayName: (userId, name) => q.setDisplayName.run(name, userId),
    setAvatar: (userId, avatar) => q.setAvatar.run(avatar, userId),
    setFrame: (userId, frame) => q.setFrame.run(frame, userId),
    userLeaderboard: () => q.leaderboard.all().map(row => ({ name: row.display_name || row.username, cleared: row.cleared, avatar: row.avatar, frame: row.frame })),
    userById: id => { const row = q.userById.get(id); return row ? publicUser(row) : null; },
    deleteGuestSessions: guestId => q.deleteGuestSessions.run(guestId)
  };
}

const DUMMY = { salt: Buffer.alloc(SALT_BYTES), hash: Buffer.alloc(KEY_BYTES) };

module.exports = {
  createAuth, hashPassword, verifyPassword, hashToken, validateUsername, validatePassword, sanitizeDisplayName,
  LOGIN_FAILED, DISPLAY_NAME_MAX, SESSION_TTL, SESSION_RENEW_BELOW, GUEST_TTL, LOGIN_WINDOW, LOGIN_MAX_FAILURES, WEAK_PASSWORDS
};
