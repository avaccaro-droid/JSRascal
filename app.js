//jshint esversion:6
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const ejs = require("ejs");
const session = require('express-session');
const passport = require('passport');
const Strategy = require('passport-local').Strategy;
const uuid = require('uuid');
const AWS = require('aws-sdk');
AWS.config.update({
    region: "eu-west-2",
});
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
const app = express();

app.use(express.static("public"));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({
	extended: true,
}));
app.use(session({
	secret: process.env.SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	cookie: {
		maxAge: 60 * 60 * 1000,
	},
}));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new Strategy(function(username, password, cb) {
    const params = {
        TableName: process.env.USER_TABLE_NAME,
        Key: {
            username: username,
        },
    };

    //get user
    dynamoDb.get(params, (error, result) => {
    	if (error) {
    		console.error(error);
    	}

    	if (userValid(result.Item) && result.Item.password === password) {
    		return cb(null, result.Item);
    	}

		return cb(null, false);
    });
}));
passport.serializeUser(function(user, cb) {
	cb(null, user.username);
});
passport.deserializeUser(function(username, cb) {
	const params = {
        TableName: process.env.USER_TABLE_NAME,
        Key: {
            username: username,
        },
    };

    dynamoDb.get(params, (error, result) => {
    	if (error) {
    		console.error(error);
    	}

    	if (userValid(result.Item)) {
    		return cb(null, result.Item);
    	}
    });
});

//object validation methods
function objValid(obj) {
	return obj !== null && typeof obj !== 'undefined' && obj.length !== 0;
}

function userValid(user) {
	if (user !== null && typeof user !== 'undefined') {
        return user.username !== null && typeof user.username !== 'undefined' && user.username.length !== 0;
    }
    return false;
}

function lastEvaluatedKeyValid(lastEvaluatedKey) {
    return lastEvaluatedKey !== null && typeof lastEvaluatedKey !== 'undefined' && lastEvaluatedKey.length !== 0;
}

//utils
function generateTimestamp() {
    let d = new Date();
    return d.toISOString().replace("T", " ").replace("Z", "");
}

//db scan methods
function scanStores(params, stores, callback) {
    dynamoDb.scan(params, (error, result) => {
        if (error) {
            console.error(error);
            return callback(error, null);
        } else if (lastEvaluatedKeyValid(result.LastEvaluatedKey)) {
        	//if LastEvaluatedKey is present & valid, we need to paginate
            //assign objects
            stores.push(...result.Items);

            //modify params
            params["ExclusiveStartKey"] = result.LastEvaluatedKey;

            //recursive call
            scanStores(params, stores, callback);
        } else {
        	//assign objects to class variable
            stores.push(...result.Items);

            //no more pagination required
            return callback(null, stores);
        }
    });
}

//db delete methods
function deleteStore(storeNumber, callback) {
	const params = {
	    TableName: process.env.STORE_TABLE_NAME,
	    Key: {
	        storeNumber: storeNumber,
	    },
	};

	//delete item
	dynamoDb.delete(params, (error, result) => {
	    //handle potential errors
	    if (error) {
	        console.error(error);
	    }

	    return callback(error);
	});
}

//db add methods
function addStore(storeNumber, storeName, file, fileContents, callback) {
	//when adding a store we need to first upload the file to s3
	const s3Params = {
		Bucket: 'js-rascal-staging',
		Key: file,
		Body: fileContents,
	};

	s3.putObject(s3Params, function(err, data) {
		if (err) {
			console.log(err);
			//don't proceed if an error has occurred
			return callback(err);
		}

		//s3 upload successful, now insert into db
		const params = {
		    TableName: process.env.STORE_TABLE_NAME,
		    Item: {
		        storeNumber: storeNumber,
		        storeName: storeName,
		        iniFile: file,
		    },
		};

		//put item
		dynamoDb.put(params, (error) => {
		    //handle potential errors
		    if (error) {
		        console.error(error);
		    }

		    return callback(error);
		});
	});
}

//sorting/filtering methods
function filterStores(stores, pageNo) {
	let filteredStores = [];

	const startingRow = (pageNo * 50) - 49;
	const endingRow = startingRow + 49;
	let rowCounter = 1;
	for (let x = 0; x < stores.length; x++) {
		if (rowCounter >= startingRow && rowCounter <= endingRow) {
			filteredStores.push(stores[x]);
		}

		rowCounter++;
	}

	return filteredStores;
}

//webpage loading methods
function loadViewStoresPage(req, res) {
	let params = {
		TableName: process.env.STORE_TABLE_NAME,
	};

	if (objValid(req.query.storeNumber)) {
		params['FilterExpression'] = '#storeNumber = :storeNumber';
		params['ExpressionAttributeNames'] = {
        	"#storeNumber": "storeNumber",
    	};
		params['ExpressionAttributeValues'] = {
    		":storeNumber": req.query.storeNumber,
    	};
	} else if (objValid(req.query.storeName)) {
		params['FilterExpression'] = '#storeName = :storeName';
		params['ExpressionAttributeNames'] = {
        	"#storeName": "storeName",
    	};
		params['ExpressionAttributeValues'] = {
    		":storeName": req.query.storeName,
    	};
	}

	const pageNo = objValid(req.query.pageNo) ? req.query.pageNo : '1';
	const startingRow = (pageNo * 50) - 49;
	const endingRow = startingRow + 49;

	let emptyStoresArray = [];
	scanStores(params, emptyStoresArray, function(error, stores) {
		if (error !== null) {
		    //TODO - error scenario
		} else {
        	//contacts OK, now show screen
			res.render("view-stores", {
        		user: req.user,
	        	stores: filterStores(stores, pageNo),
	        	filterStoreNumber: req.query.storeNumber,
	        	filterStoreName: req.query.storeName,
	        	pageNo: stores.length === 0 ? 0 : pageNo,
	        	startingRow: stores.length === 0 ? 0 : startingRow,
	        	endingRow: stores.length === 0 ? 0 : stores.length < endingRow ? stores.length : endingRow,
	        	totalStores: stores.length,
        	});
		}
	});
}

//GET routes
app.get("/", function(req, res) {
	if (req.isAuthenticated()) {
		loadViewStoresPage(req, res);
	} else {
		res.sendFile(__dirname + "/login.html");
	}
});

app.get("/login.html", function(req, res) {
	res.sendFile(__dirname + "/login.html");
});

app.get("/view-stores.html", function(req, res) {
	if (req.isAuthenticated()) {
		loadViewStoresPage(req, res);
	} else {
		res.sendFile(__dirname + "/login.html");
	}
});

app.get("/logout.html", function(req, res) {
	req.logout();
	res.redirect("/");
});

//POST routes
app.post("/login.html", function(req, res) {
	passport.authenticate("local")(req, res, function() {
		res.redirect(req.headers.referer);
	});
});

app.post("/delete-store.html", function(req, res) {
	//is user logged in?
	if (req.isAuthenticated()) {
		const storeNumber = req.body.storeNumber;
			
		if (!objValid(storeNumber)) {
			//TODO - notify user?
			return;
		}

		deleteStore(storeNumber, function(error) {
			res.redirect("/view-stores.html");
		});
	} else {
		res.sendFile(__dirname + "/login.html");
	}
});

app.post("/add-store.html", function(req, res) {
	//is user logged in?
	if (req.isAuthenticated()) {
		const storeNumber = req.body.storeNumber;
		const storeName = req.body.storeName;
		const file = req.body.file;
		const fileContents = req.body.fileContents;

		if (!objValid(storeNumber) || !objValid(storeName) || !objValid(file) || !objValid(fileContents)) {
			//TODO - notify user?
			return;
		}

		addStore(storeNumber, storeName, file, fileContents, function(error) {
			res.redirect("/view-stores.html");
		});
	} else {
		res.sendFile(__dirname + "/login.html");
	}
});

app.post("/logout.html", function(req, res) {
	req.logout();
	res.redirect("/");
});

//init service
app.listen(process.env.PORT, function() {
	console.log("Server started on port " + process.env.PORT);
});
